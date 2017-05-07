import jssgf from 'jssgf';
import { Meteor } from 'meteor/meteor';
import { GtpLeela, nextMove, cancelById, coord2move, move2coord }
    from 'meteor/new3rs:gtp-leela';
import { Rooms } from '/imports/api/rooms/rooms.js';

function sleep(delay) {
    return new Promise(function(resolve, reject) {
        setTimeout(resolve, delay);
    });
}

/**
 * ついー碁でプレイするAIエージェント
 */
export class Agent {
    /**
     * @param {object} selector - Meteor.usersからプレーヤを選択するセレクタ
     * @param {string} methods - DDPサーバ
     */
    constructor(selector, methods = Meteor) {
        this.methods = methods;
        this.user = Meteor.users.find(selector);
        if (this.user.count() != 1) {
            throw new Meteor.Error('invalid selector');
        }
        this.id = this.user.fetch()[0]._id;
        this.userChanged = this.userChanged.bind(this);
        this.rooms = Rooms.find(this.getRoomsSelector());
        this.thinkingRooms = [];
    }
    destroy() {
        this.stopObserve();
    }
    enterRoom(id) {
        this.methods.call('room.enter', id, this.id);
        return true;
    }
    exitRoom(id) {
        this.methods.call('room.exit', id, this.id);
        return true;
    }
    exitAllRooms() {
        this.rooms.forEach(room => {
            this.exitRoom(room._id);
        });
    }
    userChanged(id, fields) {
        if (!(fields.twiigo && fields.twiigo.request)) {
            return null;
        }
        const roomId = this.methods.call('room.make', this.id);
        this.enterRoom(roomId);
    }
    removeFromThinkingRooms(roomId) {
        const index = this.thinkingRooms.indexOf(roomId);
        if (index < 0) {
            return;
        }
        this.thinkingRooms.splice(index, 1);
    }
    async think(id, sgf, byoyomi) {
        return nextMove(id, sgf, byoyomi);
    }
    async stopThink(id) {
        cancelById(id);
    }
    async play(room, color, root, node, delay) {
        if (this.thinkingRooms.includes(room._id)) {
            return
        }
        this.thinkingRooms.push(room._id);
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
                this.removeFromThinkingRooms(room._id);
                if (e.message === 'This socket is closed.') {
                    throw new Error('no gtp command', 'COMMAND not found');
                } else if (e.signal === 'SIGINT') { // terminate
                    throw e;
                } else {
                    console.log(e);
                }
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
        this.removeFromThinkingRooms(room._id);
        Rooms.update(room._id, { $set: { aiThought: data }});
    }
    async behave(room, old) {
        const opponentId = room.black === this.id ? room.white : room.black;
        // 入室
        if (!room.mates.some(e => e.startsWith(this.id))) {
            if (room.mates.some(e => e.startsWith(opponentId))) {
                if (!this.enterRoom(room._id)) {
                    return;
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
                this.exitRoom(room._id);
            }
        } else if (root._children.length === 0) {
            const whiteSen = root.HA && parseInt(root.HA) >= 2;
            if ((whiteSen && color === 'W') || (!whiteSen && color === 'B')) {
                await this.play(room, color, root, root, 3000);
            } else if (!room.mates.some(e => e.startsWith(opponentId))) {
                console.log("behave: opponent left room before first move");
                this.stopThink(room._id);
                console.log('behave2');
                this.exitRoom(room._id);
            }
        } else {
            const node = jssgf.nthMoveNode(root, Infinity);
            if (node[color]) {
                if (!room.mates.some(e => e.startsWith(opponentId))) {
                    console.log("behave: opponent left room on the way");
                    this.stopThink();
                    console.log('behave3');
                    this.exitRoom(room._id);
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
        this.selfObserver = this.user.observeChanges({ changed: this.userChanged });
        const handler = (room, old) => {
            this.behave(room, old).catch(function (reason) {
                console.log(reason);
            });
        }
        this.roomObserver = this.rooms.observe({
            added: handler,
            changed: handler
        });
    }
    stopObserve() {
        console.log('stopObserve');
        this.stopThink();
        Meteor.defer(() => {
            if (this.selfObserver) {
                this.selfObserver.stop();
            }
            if (this.roomObserver) {
                this.roomObserver.stop();
            }
            this.exitAllRooms();
        });
    }
}
/**
 * ポンダーAIエージェント
 */
export class PonderAgent extends Agent {
    enterRoom(id) {
        if (this.room && this.room !== id) {
            console.log('already playing other game', this.room, id);
            return false;
        }
        this.room = id;
        return super.enterRoom(id);
    }
    exitRoom(id) {
        this.room = null;
        return super.exitRoom(id);
    }
    exitAllRooms() {
        this.exitRoom(this.room);
        this.room = null;
    }
    userChanged(id, fields) {
        if (this.room) {
            console.log('already playing');
            return;
        }
        super.userChanged(id, fields);
    }
    async think(id, sgf, byoyomi) {
        try {
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
        } catch(e) {
            this.gtp = null;
            throw e;
        }
    }
    async stopThink(id) {
        if (this.gtp) {
            await this.gtp.terminate();
            this.gtp = null;
        }
    }
}
