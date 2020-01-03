// - debugging API
//    - which rules are ready to run? showing match in world?
//    - which ones get to run?

namespace tileworld {

    class TileSprite extends Sprite {
        // the direction the sprite is currently moving
        public dir: MoveDirection;
        // the one instruction history to apply to the sprite to 
        // create the next sprite state
        public inst: number;
        public arg: number;
        // collision instruction
        public collide: number;
        constructor(img: Image, kind: number) {
            super(img);
            const scene = game.currentScene();
            scene.physicsEngine.addSprite(this);
            this.setKind(kind);
            this.dir = -1;
            this.inst = -1;
            this.collide = -1;
        }
        public col() { return this.x >> 4; }
        public row() { return this.y >> 4; }
        public update() {
            this.dir = this.inst == CommandType.Move ? this.arg : -1;
            this.vx = this.dir == MoveDirection.Left ? -100 : this.dir == MoveDirection.Right ? 100 : 0;
            this.vy = this.dir == MoveDirection.Up ? -100 : this.dir == MoveDirection.Down ? 100 : 0;
        }
    }

    class VMState {
        public fixed: number;
        public all: number;
        public nextWorld: Image;
        public sprites: TileSprite[][];
        public globalCommands: number[];
        public globalArgs: number[];
        constructor() {}
    }

    class RuleClosure {
        constructor(
            public rid: number,
            public self: TileSprite,
            public witnesses: TileSprite[]) {
        }
    }

    enum Phase { Moving, Resting, Colliding };

    class TileWorldVM {
        private ruleClosures: RuleClosure[];
        private gs: VMState;
        private dpad: MoveDirection
        // (temporary) state for collision detection
        private moving: TileSprite[];
        private other: TileSprite;

        constructor(private p: Project, private rules: number[]) {
            this.gs = null;
        }

        public setState(gs: VMState) {
            this.gs = gs;
        }

        public round(currDir: MoveDirection) {
            if (!this.gs)
                return;
            this.dpad = currDir;
            this.moving = [];
            // make sure everyone is centered
            this.allSprites(ts => {
                ts.x = ((ts.x >> 4) << 4) + 8;
                ts.y = ((ts.y >> 4) << 4) + 8;
            })
            this.other = null;
            this.gs.nextWorld.fill(0xf);
            this.allSprites(ts => { ts.inst = -1; ts.collide = -1; });
            // compute the "pre-effect" of the rules
            this.ruleClosures = [];
            this.applyRules(Phase.Moving);
            this.ruleClosures.forEach(rc => this.evaluateRuleClosure(rc));
            this.ruleClosures = [];
            this.applyRules(Phase.Resting);
            this.ruleClosures.forEach(rc => this.evaluateRuleClosure(rc));
            // now, look for collisions
            this.ruleClosures = [];
            //this.collisionDetection();
            //this.ruleClosures.forEach(rc => this.evaluateRuleClosure(rc));
            // finally, update the rules
            this.updateWorld();
        }

        private matchingRules(phase: Phase, ts: TileSprite, handler: (ts: TileSprite, rid:number) => void) {
            this.rules.forEach(rid => {
                if (   this.p.getKinds(rid).indexOf(ts.kind()) != -1 && 
                    (  phase == Phase.Moving && this.p.getDir(rid) == ts.dir && this.p.getType(rid) == RuleType.Moving
                    || phase == Phase.Resting && this.p.getType(rid) == RuleType.Resting
                    || this.p.getDir(rid) == this.dpad && this.p.getType(rid) == RuleType.Pushing) ) 
                {
                    handler(ts,rid);
                }
            });
        }

        private allSprites(handler: (ts:TileSprite) => void) {
            this.gs.sprites.forEach(ls => { if (ls) ls.forEach(ts => handler(ts)); });
        }

        private applyRules(phase: Phase) {
            this.allSprites(ts => { 
                if ( (phase == Phase.Moving && ts.dir != -1) ||
                     (phase == Phase.Resting && (ts.dir == -1 ||
                         ts.inst != CommandType.Move)) ) {
                    let witnesses: TileSprite[] = [];
                    this.matchingRules(phase, ts, (ts,rid) => {
                        let closure = this.evaluateRule(ts, rid);
                        if (closure)
                            this.ruleClosures.push(closure);
                    });
                }
            });
        }

        private collidingRules(ts: TileSprite, handler: (ts: TileSprite, rid: number) => void) {
            this.rules.forEach(rid => {
                if (this.p.getKinds(rid).indexOf(ts.kind()) != -1 && 
                    this.p.getType(rid) == RuleType.Colliding &&
                    this.p.getDir(rid) == ts.dir) {
                        handler(ts, rid);
                }
            });
        }

        // for each sprite ts that is NOW moving (into T):
        // - look for colliding sprite os != ts, as defined
        //   (a) os in square T, resting or moving towards ts, or
        //   (b) os moving into T
        // TODO: this can be optimized, a lot
        private collisionDetection() {
            this.allSprites(ts => { if (ts.inst == CommandType.Move) this.moving.push(ts) }); 
            this.moving.forEach(ts => {
                if (ts.inst != CommandType.Move) return;
                this.collidingRules(ts, (ts,rid) => {
                    let wcol = ts.col() + moveXdelta(ts.arg);
                    let wrow = ts.row() + moveYdelta(ts.arg);
                    this.other = null;
                    // T = (wcol, wrow)
                    this.allSprites(os => {
                        if (os == ts) return;
                        // (a) os in square T, resting or moving towards ts, or
                        if (os.col() == wcol && os.row() == wrow) {
                            if (os.inst != CommandType.Move || oppDir(ts.arg,os.arg))
                                this.collide(rid, ts, os, wcol, wrow);
                        } else {
                            let leftRotate = flipRotateDir(ts.arg, FlipRotate.Left);
                            let osCol = wcol + moveXdelta(leftRotate);
                            let osRow = wrow + moveYdelta(leftRotate);
                            if (os.col() == osCol && os.row() == osRow && 
                                os.inst == CommandType.Move && oppDir(leftRotate,os.arg)) {
                                this.collide(rid, ts, os, wcol, wrow);
                            }
                            let rightRotate = flipRotateDir(ts.arg, FlipRotate.Right);
                            osCol = wcol + moveXdelta(rightRotate);
                            osRow = wrow + moveYdelta(rightRotate);
                            if (os.col() == osCol && os.row() == osRow &&
                                os.inst == CommandType.Move && oppDir(rightRotate, os.arg)) {
                                this.collide(rid, ts, os, wcol, wrow);
                            }
                        }
                    });
                });
            });
        }

        private collide(rid: number, ts: TileSprite, os: TileSprite, ocol: number, orow: number) {
            let witnesses: TileSprite[] = [];
            let ret = this.evaluateWhenDo(ts, rid, ocol, orow, witnesses);
            if (ret) {
                this.ruleClosures.push(new RuleClosure(rid, ts, witnesses));
            }
        }

        private updateWorld() {
            this.allSprites(ts => ts.update() );
            // change tiles (can be done with less memory and time assuming few
            // tiles are changed).
            for(let x = 0; x < this.gs.nextWorld.width; x++) {
                for (let y = 0; y < this.gs.nextWorld.height; y++) {
                    let pixel = this.gs.nextWorld.getPixel(x, y);
                    if (pixel != 0xf) {
                        //this.gs.world.setPixel(x, y, pixel);
                        const tm = game.currentScene().tileMap;
                        tm.setTileAt(x, y, pixel);
                    }
                }                
            }
            for(let i = 0; i<this.gs.globalCommands.length; i++) {
                let arg = this.gs.globalArgs[i];
                switch(this.gs.globalCommands[i]) {
                    case CommandType.Game: {
                        if (arg == GameArg.Win || arg == GameArg.Lose) {
                            game.over(arg == GameArg.Win);
                        }
                        break;
                    }
                    case CommandType.SpritePred: {
                        let check = this.gs.sprites[arg];
                        if (check && check.length > 0) {
                            // skip next instruction if predicate = 0 doesn't hold
                            i = i + 1;
                        }
                        break;
                    }
                }
            }
            this.gs.globalCommands = [];
            this.gs.globalArgs = [];
        }

        // store the sprite witnesses identified by guards
        private evaluateRule(ts: TileSprite, rid: number) {
            let witnesses: TileSprite[] = [];
            for(let col = 0; col < 5; col++) {
                for (let row = 0; row < 5; row++) {
                    if (Math.abs(2-col) + Math.abs(2-row) > 2 ||
                        col == 2 && row == 2)
                        continue;
                    if (!this.evaluateWhenDo(ts, rid, col, row, witnesses))
                        return null;
                }
            }
            return new RuleClosure(rid, ts, witnesses);
        }

        private getWitness(kind: number, col: number, row: number) {
            return this.gs.sprites[kind] && this.gs.sprites[kind].find(ts => ts.col() == col && ts.row() == row);
        }

        private inBounds(col: number, row: number) {
            return 0 <= col && col < this.gs.nextWorld.width &&
                0 <= row && row < this.gs.nextWorld.height;
        }

        private allTrue(rid: number, whendo: number) {
            for(let kind = 0; kind < this.gs.all; kind++) {
                if (this.p.getAttr(rid, whendo, kind) != AttrType.OK)
                    return false;
            }
            return true;
        }

        private evaluateWhenDo(ts: TileSprite, rid: number, 
                col: number, row: number, witnesses: TileSprite[]) {
            let whendo = this.p.getWhenDo(rid, col, row);
            if (whendo == -1 || this.allTrue(rid, whendo))
                return true;
            let wcol = ts.col() + (col - 2);
            let wrow = ts.row() + (row - 2);
            if (!this.inBounds(wcol, wrow))
                return false;
            let oneOf: boolean = false;
            let oneOfPassed: boolean = false;
            let captureWitness: TileSprite = null;
            for(let kind = 0; kind < this.gs.fixed; kind++) {
                // let hasKind = this.gs.world.getPixel(wcol, wrow) == kind;
                const tm = game.currentScene().tileMap;
                let hasKind = tm.getTile(wcol, wrow).tileSet == kind;
                let attr = this.p.getAttr(rid, whendo, kind);
                if (attr == AttrType.Exclude && hasKind ||
                    attr == AttrType.Include && !hasKind) {
                    return false;
                } else if (attr == AttrType.OneOf) {
                    oneOf = true;
                    if (hasKind) oneOfPassed = true;
                }
            }
            for(let kind = this.gs.fixed; kind<this.gs.all; kind++) {
                let attr = this.p.getAttr(rid, whendo, kind);
                let witness = this.getWitness(kind, wcol, wrow);
                if (this.other && this.other.kind() == kind)
                    witness = this.other;
                if (attr == AttrType.Exclude && witness) {
                    return false;
                } else if (attr == AttrType.Include) {
                    if (!witness) return false;
                    if (!captureWitness)
                        captureWitness = witness;
                } else if (attr == AttrType.OneOf) {
                    oneOf = true;
                    if (witness) oneOfPassed = true;
                    if (!captureWitness)
                        captureWitness = witness;
                }
            }
            let ret = !oneOf || oneOfPassed;
            if (ret && Math.abs(2 - col) + Math.abs(2 - row) <= 1) {
                if (captureWitness)
                    witnesses.push(captureWitness);
            }
            return ret;
        }
    
        private evaluateRuleClosure(rc: RuleClosure) {
            for (let col = 0; col < 5; col++) {
                for (let row = 0; row < 5; row++) {
                    if (Math.abs(2 - col) + Math.abs(2 - row) > 2)
                        continue;
                    this.evaluateWhenDoCommands(rc, col, row);
                }
            }
        }

        private evaluateWhenDoCommands(rc: RuleClosure, col: number, row: number) {
            let wid = this.p.getWhenDo(rc.rid, col, row);
            if (wid == -1 || this.p.getInst(rc.rid, wid, 0) == -1)
                return;
            let wcol = rc.self.col() + (col - 2);
            let wrow = rc.self.row() + (row - 2);
            let self = col == 2 && row == 2;
            for (let cid = 0; cid < 4; cid++) {
                let inst = this.p.getInst(rc.rid, wid, cid);
                let arg = this.p.getArg(rc.rid, wid, cid);
                if (inst == -1) break;
                switch(inst) {
                    case CommandType.Paint: {
                        if (this.gs.nextWorld.getPixel(wcol, wrow) == 0xf) {
                            this.gs.nextWorld.setPixel(wcol, wrow, arg);
                        }
                        return;
                    }
                    case CommandType.Move: {
                        let witness = self ? rc.self : rc.witnesses.find(ts => ts.col() == wcol && ts.row() == wrow);
                        if (witness) {
                            if (witness.inst == -1 || (witness.inst == CommandType.Move && arg == MoveArg.Stop)) {
                                witness.inst = inst;
                                witness.arg = arg;
                            }
                        }
                        return;
                    }
                    case CommandType.Sprite: {
                        return;
                    }
                    case CommandType.Game:
                    case CommandType.SpritePred: {
                        this.gs.globalCommands.push(inst);
                        this.gs.globalCommands.push(arg);
                        return;
                    }
                }
            }
        }
    }

    export class RunGame extends BackgroundBase {
        private vm: TileWorldVM;
        private signal: TileSprite;
        private state: VMState;
        constructor(private p: Project, rules: number[]) {
            super();
            this.vm = new TileWorldVM(p, rules)
        }
        
        public setWorld(w: Image) {
            this.dirQueue = [];
            this.signal = null;
            this.state = new VMState();
            this.state.fixed = this.p.fixed().length;
            this.state.all = this.p.all().length;
            this.state.sprites = [];
            this.state.globalCommands = [];
            this.state.globalArgs = [];
            scene.setTileMap(w.clone());
            this.state.nextWorld = w.clone();

            // initialize fixed and movable sprites
            for (let kind = 0;kind < this.p.all().length; kind++) {
                let art = this.p.getImage(kind);
                if (kind < this.p.fixed().length) {
                    scene.setTile(kind, art);
                } else {
                    this.state.sprites[kind] = [];
                    let tiles = scene.getTilesByType(kind);
                    let tm = game.currentScene().tileMap;
                    for (let t of tiles) {
                        let tileSprite = new TileSprite(art, kind);
                        this.state.sprites[kind].push(tileSprite);
                        t.place(tileSprite);
                        scene.setTileAt(t, this.p.defaultTile);
                    } 
                }
            }
        }

        public start() {
            let signal = new TileSprite(cursorIn, 0);
            signal.setFlag(SpriteFlag.Invisible, true);
            signal.x = signal.y = 8;
            signal.dir = MoveDirection.Right;
            signal.inst = -1;
            this.signal = signal;

            // get the game started
 
            let playerId = this.p.getPlayer();
            if (playerId != -1 && this.state.sprites[playerId]) {
                scene.cameraFollowSprite(this.state.sprites[playerId][0]);
            }

            this.vm.setState(this.state);
            this.vm.round(-1);
            game.onUpdate(() => {
                // has signal sprite moved to new tile
                // then do a worldUpdate and reset the signal sprite
                if (this.signal.x >= 23) {
                    this.signal.x = 8;
                    let currentDirection = this.dirQueue.length > 0 ? this.dirQueue[0] : -1;
                    this.vm.round(currentDirection);
                    if (currentDirection != -1) {
                        if (!this.keyDowns[currentDirection])
                            this.dirQueue.removeElement(currentDirection);
                    }
                }
            });

            this.keyDowns = [false, false, false, false, false];
            this.registerController();
            signal.vx = 100;
        }

        private registerController() {
            controller.left.onEvent(ControllerButtonEvent.Pressed, () => {
                this.requestMove(MoveDirection.Left)
            })
            controller.left.onEvent(ControllerButtonEvent.Released, () => {
                this.requestStop(MoveDirection.Left)
            })
            controller.right.onEvent(ControllerButtonEvent.Pressed, () => {
                this.requestMove(MoveDirection.Right)
            })
            controller.right.onEvent(ControllerButtonEvent.Released, () => {
                this.requestStop(MoveDirection.Right)
            })
            controller.up.onEvent(ControllerButtonEvent.Pressed, () => {
                this.requestMove(MoveDirection.Up)
            })
            controller.up.onEvent(ControllerButtonEvent.Released, () => {
                this.requestStop(MoveDirection.Up)
            })
            controller.down.onEvent(ControllerButtonEvent.Pressed, () => {
                this.requestMove(MoveDirection.Down)
            })
            controller.down.onEvent(ControllerButtonEvent.Released, () => {
                this.requestStop(MoveDirection.Down)
            })
            controller.B.onEvent(ControllerButtonEvent.Pressed, () => {
                game.popScene();
            })
        }
        private dirQueue: MoveDirection[];
        private keyDowns: boolean[];
        private requestMove(dir: MoveDirection) {
            this.keyDowns[dir] = true;
            if (this.dirQueue.length == 0 || this.dirQueue.length == 1 && dir != this.dirQueue[0])
                this.dirQueue.insertAt(0,dir);
        }

        private requestStop(dir: MoveDirection) {
            this.keyDowns[dir] = false;
            let index = this.keyDowns.indexOf(true);
            if (index != -1 && this.dirQueue.length == 0)
                this.dirQueue.push(index);
        }
    }
}
