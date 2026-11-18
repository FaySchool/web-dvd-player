/*****************************************************************************
 * emscripten.c: Emscripten webaudio output
 *****************************************************************************
 * Copyright © 2022 VLC authors, VideoLAN and Videolabs
 *
 * This program is free software; you can redistribute it and/or modify
 * it under the terms of the GNU Lesser General Public License as published by
 * the Free Software Foundation; either version 2.1 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public License
 * along with this program; if not, write to the Free Software Foundation,
 * Inc., 51 Franklin Street, Fifth Floor, Boston MA 02110-1301, USA.
 *****************************************************************************/

class Processor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.port.onmessage = e => {
            if (e.data.type === "recv-audio-queue") {
                this.is_paused = e.data.is_paused;
                this.head = e.data.head;
                this.tail = e.data.tail;
                this.can_write = e.data.can_write;
                this.storage = e.data.storage;
                this.flush_pos = e.data.flush_pos;
                this.flush_seq = e.data.flush_seq;
                this.flush_ack = e.data.flush_ack;
                this.port.postMessage( 'ready' );
            } else {
                this.port.postMessage( 'error' );
                throw new Error('unexpected: wrong init from AudioWorkletNode');
            }
        };
    }
    
    process(inputs, outputs, parameters) {
        const output = outputs[0];
        const nbChannels = output.length;
        const nbSamples = output[0].length;
        if (this.head.buffer.byteLength === 0) {
            throw new Error('wasmMemory grew');
        }
        /* Pending flush: drop everything written before flush_pos. Only
         * this thread writes tail, so this cannot race with the writer. */
        const seq = Atomics.load(this.flush_seq, 0);
        if (seq !== Atomics.load(this.flush_ack, 0)) {
            Atomics.store(this.tail, 0, Atomics.load(this.flush_pos, 0));
            Atomics.store(this.flush_ack, 0, seq);
        }
        /* While paused, output silence but keep the buffered samples */
        if (Atomics.load(this.is_paused, 0) !== 0)
            return true;
        var head = Atomics.load(this.head, 0) / 4;
        var tail = Atomics.load(this.tail, 0) / 4;

        var i = 0;

        while (tail != head && i < nbSamples) {
            for (let c = 0; c < nbChannels; ++c) {
                output[c][i] = this.storage[tail];
                tail++;
                if (tail === this.storage.length) {
                    tail = 0;
                }
            }
            i++;
        }
        Atomics.store(this.tail, 0, tail * 4);
        Atomics.store(this.can_write, 0, 1);
        Atomics.notify(this.can_write, 0);
        return true;
    }
}

registerProcessor('worklet-processor', Processor);
