import jssgf from 'jssgf';
import { Meteor } from 'meteor/meteor';
import { GtpLeela, nextMove, cancelById, coord2move, move2coord } from 'meteor/new3rs:gtp-leela';
import { Rooms } from '/imports/api/rooms/rooms.js';

function sleep(delay) {
    return new Promise(function(resolve, reject) {
        setTimeout(function() {
            resolve();
        }, delay);
    });
}

export class Agent {
    constructor(selector, mode, methods = Meteor) {
        this.mode = mode;
        this.methods = methods;
        this.gtp = null;
        this.room = null; // serious modeでroom idを代入するとビジーを示す
        const cursor = Meteor.users.find(selector);
        if (cursor.count() != 1) {
            throw new Meteor.Error('invalid selector');
        }
        this.id = cursor.fetch()[0]._id;
        this.observeSelf = cursor.observeChanges({
            changed: (id, fields) => {
                if (fields.twiigo && fields.twiigo.request) {
                    if (!this.mode) {
                        this.methods.call('room.enter',
                            this.methods.call('room.make', id), id);
                    } else if (this.mode === 'serious' && !this.room) {
                        this.room = id;
                        this.methods.call('room.enter',
                            this.methods.call('room.make', id), id);
                    } else {
                        console.log('already playing');
                    }
                }
            }
        });
    }
    async think(id, sgf, byoyomi) {
        if (this.mode === 'serious') {
            if (this.gtp) {
                const [root] = jssgf.fastParse(sgf);
                const node = jssgf.nthMoveNode(root, Infinity);
                const size = parseInt(root.SZ || '19');
                let move;
                if (node.B != null) {
                    move = node.B;
                } else if (node.W != null) {
                    move = node.W;
                }
                await this.gtp.play(move2coord(move, size));
            } else {
                this.gtp = new GtpLeela();
                await this.gtp.loadSgf(sgf);
                if (byoyomi) {
                    await this.gtp.timeSettings(0, byoyomi, 1);
                }
            }
            return this.gtp.genmove();
        } else {
            return nextMove(id, sgf, byoyomi);
        }
    }
    async stopThink(id) {
        if (this.mode === 'serious') {
            if (this.gtp) {
                await this.gtp.terminate();
                this.gtp = null;
            }
        } else {
            cancelById(id);
        }
    }
    async play(room, color, root, node, delay) {
        if (room.aiThinking) {
            return
        }
        Rooms.update(room._id, { $set: { aiThinking: true }});
        if (delay) {
            await sleep(delay);
        }
        let data;
        while (true) {
            try {
                data = await this.think(room._id, room.game,
                    process.env.NODE_ENV === 'production' ? 15 : 1);
                break;
            } catch (e) {
                if (e.message === 'This socket is closed.') {
                    throw new Error('no gtp command', 'COMMAND not found');
                } else if (e.signal === 'SIGINT') { // terminate
                    Rooms.update(room._id, { $unset: { aiThinking: '' }});
                    throw e;
                }
                console.log(e);
                this.gtp = null; // retry
            }
        }
        switch (data && data.move) {
            case null:
            case undefined:
                root.RE = `${jssgf.opponentOf(color)}+R`;
                break;
            case 'PASS': {
                const next = { _children: [] };
                next[color] = '';
                node._children.push(next);
                break;
            }
            case 'resign':
                root.RE = `${jssgf.opponentOf(color)}+R`;
                break;
            default: {
                const next = { _children: [] };
                const size = parseInt(root.SZ || '19')
                next[color] = coord2move(data.move, size);
                node._children.push(next);
            }
        }
        this.methods.call('room.updateGame', room._id, jssgf.stringify([root]));
        data.color = color;
        Rooms.update(room._id, {
            $set: { aiThought: data },
            $unset: { aiThinking: '' }
        });
    }
    async behave(room, old) {
        const opponentId = room.black === this.id ? room.white : room.black;
        // 入室
        if (!room.mates.some(e => e.startsWith(this.id))) {
            if (room.mates.some(e => e.startsWith(opponentId))) {
                if (this.mode === 'serious') {
                    if (!this.room) {
                        this.room = room._id;
                        this.methods.call('room.enter', room._id, this.id);
                    } else if (this.room !== room._id) {
                        return;
                    }
                } else {
                    this.methods.call('room.enter', room._id, this.id);
                }
            }
            return
        }

        // 挨拶
        if (!(room.greet && room.greet.start && room.greet.start[this.id])) {
            if (room.mates.some(e => e.startsWith(opponentId))) {
                await sleep(3000);
                this.methods.call('room.greet', room._id, 'start', this.id);
            }
            return;
        }

        const color = room.black === this.id ? 'B' : 'W';
        const [root] = jssgf.fastParse(room.game);
        if (room.counting) {
            this.stopThink(room._id);
        } else if (root.RE) { // 終局
            console.log("behave: end");
            this.stopThink(room._id);
            if (!(room.greet && room.greet.end && room.greet.end[this.id])) {
                await sleep(3000);
                this.methods.call('room.greet', room._id, 'end', this.id);
                console.log('behave1');
                this.methods.call('room.exit', room._id, this.id);
                this.room = null;
            }
        } else if (root._children.length === 0) {
            const whiteSen = root.HA && parseInt(root.HA) >= 2;
            if ((whiteSen && color === 'W') || (!whiteSen && color === 'B')) {
                await this.play(room, color, root, root, 3000);
            } else if (!room.mates.some(e => e.startsWith(opponentId))) {
                console.log("behave: opponent left room before first move");
                this.stopThink(room._id);
                console.log('behave2');
                this.methods.call('room.exit', room._id, this.id);
                this.room = null;
            }
        } else {
            const node = jssgf.nthMoveNode(root, Infinity);
            if (node[color]) {
                if (!room.mates.some(e => e.startsWith(opponentId))) {
                    console.log("behave: opponent left room on the way");
                    this.stopThink();
                    console.log('behave3');
                    this.methods.call('room.exit', room._id, this.id);
                    this.room = null;
                }
            } else {
                await this.play(room, color, root, node);
            }
        }
    }
    getRoomsSelector() {
        return { $or: [
            {
                black: this.id,
                'greet.end': { $exists: false }
            },
            {
                white: this.id,
                'greet.end': { $exists: false }
            }
        ]};
    }
    observe() {
        console.log('observe');
        const handler = (room, old) => {
            this.behave(room, old).catch(function (reason) {
                console.log(reason);
            });
        }
        this.observer = Rooms.find(this.getRoomsSelector()).observe({
            added: handler,
            changed: handler
        });
    }
    stopObserve() {
        console.log('stopObserve');
        this.stopThink();
        Meteor.defer(() => {
            if (this.observer) {
                this.observer.stop();
            }
        });
    }
}
