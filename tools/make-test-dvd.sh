#!/usr/bin/env bash
#
# Generate a small DVD-Video test image with an interactive menu:
#   - VMGM root menu with two buttons ("Play movie" -> title 1, "Play extra" -> title 2)
#   - Title 1: 30 s, 3 chapters, AC-3 stereo audio, a subtitle track
#   - Title 2: 10 s, mono AC-3 192 kbps audio (like many TV-special DVDs)
#   - Title 3: 10 s, 5.1 AC-3 448 kbps audio (only reachable from the title list)
#   - Title 4: mimics structure-based copy protection: its program chain is
#     REAL-A (blue, 10 s) / DECOY (red, 10 s) / REAL-B (green, 10 s), and a
#     cell command after REAL-A jumps over the decoy. Normal playback never
#     shows the decoy; a naive linear seek lands in it.
#   - When a title ends, playback returns to the menu
#
# Requires: ffmpeg, dvdauthor (with spumux), imagemagick (convert), genisoimage
#
# Usage: tools/make-test-dvd.sh [output.iso]
set -euo pipefail

OUT="$(realpath -m "${1:-test-dvd.iso}")"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cd "$TMP"

FONT_ARGS=()
if fc-match -f '%{file}' sans >/dev/null 2>&1; then FONT_ARGS=(-font "$(fc-match -f '%{file}' sans)"); fi

# ---------------------------------------------------------------- menu ----
convert -size 720x480 gradient:'#203a60'-'#0b1020' \
    "${FONT_ARGS[@]}" -fill white -pointsize 44 -gravity north -annotate +0+70 'WEB DVD PLAYER TEST' \
    -pointsize 20 -fill '#c0c8e0' -annotate +0+130 'Use the arrow keys / mouse, then press Enter' \
    -fill '#2a4a80' -draw 'roundrectangle 210,220 510,280 12,12' \
    -fill '#2a4a80' -draw 'roundrectangle 210,310 510,370 12,12' \
    -fill white -pointsize 28 -annotate +0+235 'Play movie' -annotate +0+325 'Play extra' \
    menu_bg.png

# Sub-picture overlays: highlight (selected) and select (activated)
for kind in highlight select; do
    color='#ffb000'; [ "$kind" = select ] && color='#ff3030'
    convert -size 720x480 xc:none +antialias -fill none -stroke "$color" -strokewidth 6 \
        -draw 'roundrectangle 204,214 516,286 14,14' \
        -draw 'roundrectangle 204,304 516,376 14,14' \
        -type PaletteMatte "${kind}.png"
done
convert -size 720x480 xc:none +antialias -type PaletteMatte menu_sp.png

ffmpeg -loglevel error -y -loop 1 -i menu_bg.png -f lavfi -i anullsrc=r=48000:cl=stereo -t 2 \
    -target ntsc-dvd -aspect 4:3 -b:v 4000k -c:a ac3 -b:a 192k menu.mpg

cat > menu_spu.xml <<'EOF'
<subpictures>
  <stream>
    <spu start="00:00:00.00" force="yes" image="menu_sp.png" highlight="highlight.png" select="select.png">
      <button name="b1" x0="200" y0="210" x1="520" y1="290" down="b2" up="b2"/>
      <button name="b2" x0="200" y0="300" x1="520" y1="380" down="b1" up="b1"/>
    </spu>
  </stream>
</subpictures>
EOF
spumux -m dvd menu_spu.xml < menu.mpg > menu_final.mpg 2>/dev/null

# --------------------------------------------------------------- titles ----
ffmpeg -loglevel error -y \
    -f lavfi -i "testsrc2=size=720x480:rate=30000/1001:duration=30" \
    -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=30" \
    -vf "drawtext=text='TITLE 1  %{pts\\:hms}':fontcolor=white:fontsize=40:x=(w-tw)/2:y=h-80:box=1:boxcolor=black@0.6" \
    -target ntsc-dvd -aspect 16:9 -b:v 5000k -c:a ac3 -b:a 192k -ac 2 title1.mpg

# A subtitle track for title 1: one line every 3 seconds
{
    echo '<subpictures><stream>'
    for i in $(seq 0 8); do
        start=$((1 + i * 3))
        # DVD sub-pictures have at most 4 colours: render, then quantise
        convert -size 720x480 xc:none +antialias "${FONT_ARGS[@]}" -fill white -stroke black -strokewidth 2 \
            -pointsize 34 -gravity south -annotate +0+40 "Subtitle line $((i + 1))" "PNG32:sub$i-rgba.png"
        convert "sub$i-rgba.png" +dither -colors 3 "PNG8:sub$i.png"
        printf '<spu start="00:00:%02d.00" end="00:00:%02d.50" image="sub%d.png"/>\n' "$start" $((start + 2)) "$i"
    done
    echo '</stream></subpictures>'
} > sub_spu.xml
spumux -s 0 sub_spu.xml < title1.mpg > title1_sub.mpg 2>/dev/null

ffmpeg -loglevel error -y \
    -f lavfi -i "smptebars=size=720x480:rate=30000/1001:duration=10" \
    -f lavfi -i "sine=frequency=880:sample_rate=48000:duration=10" \
    -vf "drawtext=text='TITLE 2 (extra)  %{pts\\:hms}':fontcolor=white:fontsize=40:x=(w-tw)/2:y=h-80:box=1:boxcolor=black@0.6" \
    -target ntsc-dvd -aspect 4:3 -b:v 5000k -c:a ac3 -b:a 192k -ac 1 title2.mpg

# Title 3: 5.1 AC-3 448 kbps (like trailers / features on newer DVDs)
ffmpeg -loglevel error -y \
    -f lavfi -i "testsrc=size=720x480:rate=30000/1001:duration=10" \
    -f lavfi -i "sine=frequency=660:sample_rate=48000:duration=10" \
    -vf "drawtext=text='TITLE 3 (5.1)  %{pts\\:hms}':fontcolor=white:fontsize=40:x=(w-tw)/2:y=h-80:box=1:boxcolor=black@0.6" \
    -af "pan=5.1|FL=c0|FR=c0|FC=c0|LFE=c0|BL=c0|BR=c0" \
    -target ntsc-dvd -aspect 16:9 -b:v 5000k -c:a ac3 -b:a 448k title3.mpg

# Title 4: decoy cell skipped by navigation commands
for part in "blue 440 REAL-A t4a" "red 220 DECOY t4d" "green 660 REAL-B t4b"; do
    set -- $part
    ffmpeg -loglevel error -y \
        -f lavfi -i "color=c=$1:size=720x480:rate=30000/1001:duration=10" \
        -f lavfi -i "sine=frequency=$2:sample_rate=48000:duration=10" \
        -vf "drawtext=text='$3  %{pts\\:hms}':fontcolor=white:fontsize=48:x=(w-tw)/2:y=(h-th)/2" \
        -target ntsc-dvd -aspect 4:3 -b:v 3000k -c:a ac3 -b:a 192k -ac 2 "$4.mpg"
done

# -------------------------------------------------------------- author ----
cat > dvd.xml <<'EOF'
<dvdauthor dest="dvd" jumppad="yes">
  <vmgm>
    <menus>
      <video format="ntsc" aspect="4:3"/>
      <pgc entry="title">
        <button name="b1">jump title 1;</button>
        <button name="b2">jump title 2;</button>
        <vob file="menu_final.mpg" pause="inf"/>
      </pgc>
    </menus>
  </vmgm>
  <titleset>
    <menus>
      <video format="ntsc" aspect="16:9"/>
      <pgc entry="root">
        <pre>jump vmgm menu 1;</pre>
      </pgc>
    </menus>
    <titles>
      <video format="ntsc" aspect="16:9" widescreen="nopanscan"/>
      <audio format="ac3" lang="en"/>
      <subpicture lang="en"/>
      <pgc>
        <vob file="title1_sub.mpg" chapters="0,0:10,0:20"/>
        <post>call vmgm menu;</post>
      </pgc>
    </titles>
  </titleset>
  <titleset>
    <menus>
      <video format="ntsc" aspect="4:3"/>
      <pgc entry="root">
        <pre>jump vmgm menu 1;</pre>
      </pgc>
    </menus>
    <titles>
      <video format="ntsc" aspect="4:3"/>
      <audio format="ac3" channels="1" lang="fr"/>
      <pgc>
        <vob file="title2.mpg"/>
        <post>call vmgm menu;</post>
      </pgc>
    </titles>
  </titleset>
  <titleset>
    <menus>
      <video format="ntsc" aspect="16:9"/>
      <pgc entry="root">
        <pre>jump vmgm menu 1;</pre>
      </pgc>
    </menus>
    <titles>
      <video format="ntsc" aspect="16:9" widescreen="nopanscan"/>
      <audio format="ac3" channels="6" lang="en"/>
      <pgc>
        <vob file="title3.mpg"/>
        <post>call vmgm menu;</post>
      </pgc>
    </titles>
  </titleset>
  <titleset>
    <menus>
      <video format="ntsc" aspect="4:3"/>
      <pgc entry="root">
        <pre>jump vmgm menu 1;</pre>
      </pgc>
    </menus>
    <titles>
      <video format="ntsc" aspect="4:3"/>
      <audio format="ac3" lang="en"/>
      <pgc>
        <vob file="t4a.mpg"><cell start="0" chapter="1">jump cell 3;</cell></vob>
        <vob file="t4d.mpg"><cell start="0" program="1"/></vob>
        <vob file="t4b.mpg"><cell start="0" chapter="1"/></vob>
        <post>call vmgm menu;</post>
      </pgc>
    </titles>
  </titleset>
</dvdauthor>
EOF
VIDEO_FORMAT=NTSC dvdauthor -x dvd.xml >/dev/null 2>&1

genisoimage -quiet -dvd-video -V WEBDVD_TEST -o "$OUT" dvd/
echo "Wrote $OUT ($(du -h "$OUT" | cut -f1))"
