/*
 * dvdplayer.c - libvlc wrapper exported to the web page.
 *
 * Threading model
 * ---------------
 * The browser main thread must never block on a VLC lock: several VLC
 * threads (video output, file access, audio output) synchronously wait for
 * the main thread's JS event loop (OffscreenCanvas / MessagePort handshakes,
 * File hand-off, AudioContext creation). If the main thread were spinning on
 * the player lock at that moment, both sides would wait forever.
 *
 * So the page never calls libvlc directly. Instead:
 *   - commands are pushed to a small queue (dvd_cmd*), which only takes a
 *     private mutex that is never held across a libvlc call;
 *   - a dedicated control thread executes them and periodically publishes a
 *     snapshot of the player state into plain memory (dvd_state()), plus
 *     JSON descriptions of titles and tracks (dvd_get_json()).
 *   - libvlc events are forwarded asynchronously (MAIN_THREAD_ASYNC_EM_ASM).
 */
#include <pthread.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <errno.h>

#include <vlc/vlc.h>

#include <emscripten.h>
#include <emscripten/html5.h>

/* Defined in the patched emscripten window module (VLC) */
extern void wasm_window_mouse_event(int type, int x, int y, int button);

static libvlc_instance_t *vlc = NULL;
static libvlc_media_player_t *mp = NULL;

/* ---------------------------------------------------------------------- */
/* Published state (read by JS straight from the wasm heap as Float64)     */
/* ---------------------------------------------------------------------- */

enum {
    ST_STATE, ST_TIME, ST_LENGTH, ST_POSITION, ST_TITLE, ST_TITLE_COUNT,
    ST_CHAPTER, ST_CHAPTER_COUNT, ST_VOLUME, ST_MUTE, ST_SEEKABLE, ST_VOUTS,
    ST_JSON_VERSION, ST_RATE, ST_COUNT
};
static double state[ST_COUNT];

EMSCRIPTEN_KEEPALIVE double *dvd_state(void) { return state; }

/* JSON blobs, guarded by json_lock (never held across libvlc calls) */
enum { JSON_TITLES, JSON_AUDIO, JSON_SPU, JSON_COUNT };
static pthread_mutex_t json_lock = PTHREAD_MUTEX_INITIALIZER;
static char *json[JSON_COUNT];

/* Returns a malloc()ed copy, to be released with free() by the caller. */
EMSCRIPTEN_KEEPALIVE
char *dvd_get_json(int which)
{
    if (which < 0 || which >= JSON_COUNT)
        return NULL;
    pthread_mutex_lock(&json_lock);
    char *copy = strdup(json[which] ? json[which] : "[]");
    pthread_mutex_unlock(&json_lock);
    return copy;
}

/* ---------------------------------------------------------------------- */
/* Command queue                                                          */
/* ---------------------------------------------------------------------- */

enum {
    CMD_OPEN = 1, CMD_PLAY, CMD_SET_PAUSE, CMD_STOP, CMD_SET_TIME,
    CMD_SET_POSITION, CMD_NAVIGATE, CMD_SET_TITLE, CMD_SET_CHAPTER,
    CMD_NEXT_CHAPTER, CMD_PREV_CHAPTER, CMD_SELECT_TRACK, CMD_SET_VOLUME,
    CMD_SET_MUTE, CMD_DEINTERLACE, CMD_MOUSE, CMD_SET_RATE, CMD_MENU,
};

typedef struct cmd {
    struct cmd *next;
    int op;
    int i0, i1, i2, i3;
    double d;
    char *str;
} cmd_t;

static pthread_mutex_t q_lock = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t q_wait = PTHREAD_COND_INITIALIZER;
static cmd_t *q_head = NULL, *q_tail = NULL;
static bool q_dirty = false;        /* a libvlc event asked for a refresh */

static void push(cmd_t *c)
{
    pthread_mutex_lock(&q_lock);
    /* Coalesce mouse moves: only the latest position matters */
    if (c->op == CMD_MOUSE && c->i0 == 0 && q_tail && q_tail->op == CMD_MOUSE
     && q_tail->i0 == 0)
    {
        q_tail->i1 = c->i1;
        q_tail->i2 = c->i2;
        free(c);
    }
    else
    {
        c->next = NULL;
        if (q_tail) q_tail->next = c; else q_head = c;
        q_tail = c;
    }
    pthread_cond_signal(&q_wait);
    pthread_mutex_unlock(&q_lock);
}

EMSCRIPTEN_KEEPALIVE
void dvd_cmd(int op, int i0, int i1, int i2, int i3, double d)
{
    cmd_t *c = calloc(1, sizeof(*c));
    if (!c) return;
    c->op = op; c->i0 = i0; c->i1 = i1; c->i2 = i2; c->i3 = i3; c->d = d;
    push(c);
}

EMSCRIPTEN_KEEPALIVE
void dvd_cmd_str(int op, int i0, const char *str)
{
    cmd_t *c = calloc(1, sizeof(*c));
    if (!c) return;
    c->op = op; c->i0 = i0;
    c->str = strdup(str ? str : "");
    push(c);
}

static void mark_dirty(void)
{
    pthread_mutex_lock(&q_lock);
    q_dirty = true;
    pthread_cond_signal(&q_wait);
    pthread_mutex_unlock(&q_lock);
}

/* ---------------------------------------------------------------------- */
/* Events -> JS (Module.onPlayerEvent)                                     */
/* ---------------------------------------------------------------------- */

/* Event kinds reported to JS. Kept stable independently of libvlc's enum. */
enum {
    EV_OPENING = 1, EV_BUFFERING, EV_PLAYING, EV_PAUSED, EV_STOPPED, EV_ERROR,
    EV_TIME, EV_LENGTH, EV_TITLE, EV_TITLE_LIST, EV_CHAPTER, EV_TRACKS, EV_VOUT,
};

static void on_event(const libvlc_event_t *ev, void *data)
{
    (void) data;
    int kind = 0;
    double value = 0;
    switch (ev->type)
    {
        case libvlc_MediaPlayerOpening:   kind = EV_OPENING; break;
        case libvlc_MediaPlayerBuffering:
            kind = EV_BUFFERING;
            value = ev->u.media_player_buffering.new_cache;
            break;
        case libvlc_MediaPlayerPlaying:   kind = EV_PLAYING; break;
        case libvlc_MediaPlayerPaused:    kind = EV_PAUSED; break;
        case libvlc_MediaPlayerStopped:   kind = EV_STOPPED; break;
        case libvlc_MediaPlayerEncounteredError: kind = EV_ERROR; break;
        case libvlc_MediaPlayerTimeChanged:
            kind = EV_TIME;
            value = (double) ev->u.media_player_time_changed.new_time;
            state[ST_TIME] = value;
            break;
        case libvlc_MediaPlayerLengthChanged:
            kind = EV_LENGTH;
            value = (double) ev->u.media_player_length_changed.new_length;
            state[ST_LENGTH] = value;
            break;
        case libvlc_MediaPlayerTitleSelectionChanged:
            kind = EV_TITLE;
            value = ev->u.media_player_title_selection_changed.index;
            break;
        case libvlc_MediaPlayerTitleListChanged: kind = EV_TITLE_LIST; break;
        case libvlc_MediaPlayerChapterChanged:
            kind = EV_CHAPTER;
            value = ev->u.media_player_chapter_changed.new_chapter;
            break;
        case libvlc_MediaPlayerESAdded:
        case libvlc_MediaPlayerESDeleted:
        case libvlc_MediaPlayerESSelected: kind = EV_TRACKS; break;
        case libvlc_MediaPlayerVout:
            kind = EV_VOUT;
            value = ev->u.media_player_vout.new_count;
            state[ST_VOUTS] = value;
            break;
        default:
            return;
    }
    if (kind != EV_TIME)
        mark_dirty();
    /* Fire-and-forget: never wait for the main thread from a VLC thread. */
    MAIN_THREAD_ASYNC_EM_ASM({
        if (Module.onPlayerEvent)
            Module.onPlayerEvent($0, $1);
    }, kind, value);
}

static const int events[] = {
    libvlc_MediaPlayerOpening,
    libvlc_MediaPlayerBuffering,
    libvlc_MediaPlayerPlaying,
    libvlc_MediaPlayerPaused,
    libvlc_MediaPlayerStopped,
    libvlc_MediaPlayerEncounteredError,
    libvlc_MediaPlayerTimeChanged,
    libvlc_MediaPlayerLengthChanged,
    libvlc_MediaPlayerTitleSelectionChanged,
    libvlc_MediaPlayerTitleListChanged,
    libvlc_MediaPlayerChapterChanged,
    libvlc_MediaPlayerESAdded,
    libvlc_MediaPlayerESDeleted,
    libvlc_MediaPlayerESSelected,
    libvlc_MediaPlayerVout,
};

/* ---------------------------------------------------------------------- */
/* JSON helpers                                                           */
/* ---------------------------------------------------------------------- */

typedef struct { char *buf; size_t len, cap; } sbuf;

static void sb_put(sbuf *b, const char *s, size_t n)
{
    if (b->len + n + 1 > b->cap)
    {
        size_t cap = b->cap ? b->cap * 2 : 256;
        while (cap < b->len + n + 1) cap *= 2;
        char *nb = realloc(b->buf, cap);
        if (!nb) return;
        b->buf = nb; b->cap = cap;
    }
    memcpy(b->buf + b->len, s, n);
    b->len += n;
    b->buf[b->len] = '\0';
}
static void sb_puts(sbuf *b, const char *s) { sb_put(b, s, strlen(s)); }
static void sb_printf(sbuf *b, const char *fmt, ...)
{
    char tmp[160];
    va_list ap; va_start(ap, fmt);
    int n = vsnprintf(tmp, sizeof(tmp), fmt, ap);
    va_end(ap);
    if (n > 0) sb_put(b, tmp, (size_t) n < sizeof(tmp) ? (size_t) n : sizeof(tmp) - 1);
}
static void sb_str(sbuf *b, const char *s)
{
    sb_puts(b, "\"");
    for (; s && *s; s++)
    {
        unsigned char c = (unsigned char) *s;
        if (c == '"' || c == '\\') { char e[2] = { '\\', (char) c }; sb_put(b, e, 2); }
        else if (c < 0x20) sb_printf(b, "\\u%04x", c);
        else sb_put(b, (const char *) &c, 1);
    }
    sb_puts(b, "\"");
}

static char *tracks_json(libvlc_track_type_t type)
{
    sbuf b = { 0 };
    sb_puts(&b, "[");
    libvlc_media_tracklist_t *list = libvlc_media_player_get_tracklist(mp, type);
    if (list != NULL)
    {
        size_t n = libvlc_media_tracklist_count(list);
        for (size_t i = 0; i < n; i++)
        {
            libvlc_media_track_t *t = libvlc_media_tracklist_at(list, i);
            if (i) sb_puts(&b, ",");
            sb_puts(&b, "{\"id\":"); sb_str(&b, t->psz_id);
            sb_puts(&b, ",\"name\":"); sb_str(&b, t->psz_name);
            sb_puts(&b, ",\"language\":"); sb_str(&b, t->psz_language);
            sb_puts(&b, ",\"description\":"); sb_str(&b, t->psz_description);
            sb_printf(&b, ",\"codec\":%u", (unsigned) t->i_codec);
            if (type == libvlc_track_audio && t->audio)
                sb_printf(&b, ",\"channels\":%u,\"rate\":%u",
                          t->audio->i_channels, t->audio->i_rate);
            sb_printf(&b, ",\"selected\":%s}", t->selected ? "true" : "false");
        }
        libvlc_media_tracklist_delete(list);
    }
    sb_puts(&b, "]");
    return b.buf;
}

static char *titles_json(void)
{
    sbuf b = { 0 };
    sb_puts(&b, "[");
    libvlc_title_description_t **titles = NULL;
    int n = libvlc_media_player_get_full_title_descriptions(mp, &titles);
    for (int i = 0; i < n; i++)
    {
        if (i) sb_puts(&b, ",");
        sb_printf(&b, "{\"index\":%d,\"duration\":%lld,\"menu\":%s,\"name\":", i,
                  (long long) titles[i]->i_duration,
                  (titles[i]->i_flags & libvlc_title_menu) ? "true" : "false");
        sb_str(&b, titles[i]->psz_name);
        sb_printf(&b, ",\"chapters\":%d}",
                  libvlc_media_player_get_chapter_count_for_title(mp, i));
    }
    if (n > 0)
        libvlc_title_descriptions_release(titles, (unsigned) n);
    sb_puts(&b, "]");
    return b.buf;
}

static void set_json(int which, char *s)
{
    if (!s) return;
    pthread_mutex_lock(&json_lock);
    bool changed = !json[which] || strcmp(json[which], s);
    if (changed)
    {
        free(json[which]);
        json[which] = s;
    }
    pthread_mutex_unlock(&json_lock);
    if (changed)
        state[ST_JSON_VERSION] += 1;
    else
        free(s);
}

/* ---------------------------------------------------------------------- */
/* Control thread                                                         */
/* ---------------------------------------------------------------------- */

static void refresh_state(bool full)
{
    state[ST_STATE] = libvlc_media_player_get_state(mp);
    state[ST_TIME] = (double) libvlc_media_player_get_time(mp);
    state[ST_LENGTH] = (double) libvlc_media_player_get_length(mp);
    state[ST_POSITION] = libvlc_media_player_get_position(mp);
    state[ST_TITLE] = libvlc_media_player_get_title(mp);
    state[ST_TITLE_COUNT] = libvlc_media_player_get_title_count(mp);
    state[ST_CHAPTER] = libvlc_media_player_get_chapter(mp);
    state[ST_CHAPTER_COUNT] = libvlc_media_player_get_chapter_count(mp);
    state[ST_VOLUME] = libvlc_audio_get_volume(mp);
    state[ST_MUTE] = libvlc_audio_get_mute(mp);
    state[ST_SEEKABLE] = libvlc_media_player_is_seekable(mp);
    state[ST_RATE] = libvlc_media_player_get_rate(mp);
    if (full)
    {
        set_json(JSON_TITLES, titles_json());
        set_json(JSON_AUDIO, tracks_json(libvlc_track_audio));
        set_json(JSON_SPU, tracks_json(libvlc_track_text));
    }
}

static void run_cmd(cmd_t *c)
{
    switch (c->op)
    {
        case CMD_OPEN:
        {
            libvlc_media_t *m = libvlc_media_new_location(vlc, c->str);
            if (m == NULL)
                break;
            if (c->i0)
                libvlc_media_add_option(m, ":demux=dvdnav");
            libvlc_media_player_set_media(mp, m);
            libvlc_media_release(m);
            libvlc_media_player_play(mp);
            break;
        }
        case CMD_PLAY:         libvlc_media_player_play(mp); break;
        case CMD_SET_PAUSE:    libvlc_media_player_set_pause(mp, c->i0); break;
        case CMD_STOP:         libvlc_media_player_stop_async(mp); break;
        case CMD_SET_TIME:     libvlc_media_player_set_time(mp, (libvlc_time_t) c->d, false); break;
        case CMD_SET_POSITION: libvlc_media_player_set_position(mp, (float) c->d, false); break;
        /* 0 activate, 1 up, 2 down, 3 left, 4 right */
        case CMD_NAVIGATE:     libvlc_media_player_navigate(mp, (unsigned) c->i0); break;
        case CMD_SET_TITLE:    libvlc_media_player_set_title(mp, c->i0); break;
        case CMD_SET_CHAPTER:  libvlc_media_player_set_chapter(mp, c->i0); break;
        case CMD_NEXT_CHAPTER: libvlc_media_player_next_chapter(mp); break;
        case CMD_PREV_CHAPTER: libvlc_media_player_previous_chapter(mp); break;
        case CMD_MENU:
            /* VLC's dvdnav module exposes the DVD menus as "title 0", whose
             * seekpoints are the menu types (0 Resume, 1 Root, 2 Title,
             * 3 Chapter, 4 Subtitle, 5 Audio, 6 Angle). Selecting title 0
             * calls the Root menu; going through set_title/set_chapter also
             * makes VLC flush its decoders before the jump. */
            if (c->i0 == 0)
            {
                /* Resume: only meaningful from a menu */
                if (libvlc_media_player_get_title(mp) == 0)
                    libvlc_media_player_set_chapter(mp, 0);
            }
            else if (c->i0 == 1)
                libvlc_media_player_set_title(mp, 0);
            else
            {
                if (libvlc_media_player_get_title(mp) != 0)
                    libvlc_media_player_set_title(mp, 0);
                libvlc_media_player_set_chapter(mp, c->i0);
            }
            break;
        case CMD_SELECT_TRACK:
            if (c->str == NULL || c->str[0] == '\0')
                libvlc_media_player_unselect_track_type(mp, (libvlc_track_type_t) c->i0);
            else
                libvlc_media_player_select_tracks_by_ids(mp, (libvlc_track_type_t) c->i0, c->str);
            break;
        case CMD_SET_VOLUME:   libvlc_audio_set_volume(mp, c->i0); break;
        case CMD_SET_MUTE:     libvlc_audio_set_mute(mp, c->i0); break;
        case CMD_SET_RATE:     libvlc_media_player_set_rate(mp, (float) c->d); break;
        case CMD_DEINTERLACE:
            if (c->str == NULL || c->str[0] == '\0')
                libvlc_video_set_deinterlace(mp, 0, NULL);
            else
                libvlc_video_set_deinterlace(mp, -1, c->str);
            break;
        /* type: 0 move, 1 press, 2 release, 3 double click */
        case CMD_MOUSE:
            wasm_window_mouse_event(c->i0, c->i1, c->i2, c->i3);
            break;
    }
}

static void *control_thread(void *arg)
{
    (void) arg;
    unsigned tick = 0;
    for (;;)
    {
        pthread_mutex_lock(&q_lock);
        if (q_head == NULL && !q_dirty)
        {
            struct timespec ts;
            clock_gettime(CLOCK_REALTIME, &ts);
            ts.tv_nsec += 200 * 1000 * 1000;
            if (ts.tv_nsec >= 1000000000) { ts.tv_sec++; ts.tv_nsec -= 1000000000; }
            pthread_cond_timedwait(&q_wait, &q_lock, &ts);
        }
        cmd_t *c = q_head;
        q_head = q_tail = NULL;
        bool dirty = q_dirty;
        q_dirty = false;
        pthread_mutex_unlock(&q_lock);

        while (c != NULL)
        {
            cmd_t *next = c->next;
            run_cmd(c);
            if (c->op != CMD_MOUSE)
                dirty = true;
            free(c->str);
            free(c);
            c = next;
        }
        /* Cheap fields every tick, track/title lists when something changed
         * (and once a second as a safety net). */
        refresh_state(dirty || (++tick % 5) == 0);
    }
    return NULL;
}

/* ---------------------------------------------------------------------- */
/* Init                                                                   */
/* ---------------------------------------------------------------------- */

EMSCRIPTEN_KEEPALIVE
int dvd_init(int argc, const char **argv)
{
    if (vlc != NULL)
        return 0;
    state[ST_TITLE] = state[ST_CHAPTER] = -1;
    vlc = libvlc_new(argc, argv);
    if (vlc == NULL)
    {
        fprintf(stderr, "dvdplayer: unable to create libvlc instance\n");
        return -1;
    }
    mp = libvlc_media_player_new(vlc);
    if (mp == NULL)
        return -1;

    libvlc_event_manager_t *em = libvlc_media_player_event_manager(mp);
    for (size_t i = 0; i < sizeof(events) / sizeof(events[0]); i++)
        libvlc_event_attach(em, events[i], on_event, NULL);

    pthread_t th;
    if (pthread_create(&th, NULL, control_thread, NULL) != 0)
        return -1;
    pthread_detach(th);
    return 0;
}

int main(void)
{
    /* Keep the runtime alive: libvlc runs on its own pthreads and every
     * JS -> C call is made later from UI events. */
    emscripten_exit_with_live_runtime();
    return 0;
}
