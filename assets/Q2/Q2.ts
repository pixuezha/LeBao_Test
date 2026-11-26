import { DropCoin, DropGate, Q2Drop } from "./Q2Drop";

const { ccclass, property } = cc._decorator;

/** Q2：场景提供美术和碰撞轮廓，掉落在 main 的本地坐标中求解。 */
const PHYSICS_STEP = 1 / 60;
// 一帧只补一次物理步。卡顿时不追帧，避免补步把下一帧再拖垮。
const MAX_FRAME_STEPS = 1;
const ROLL_START_SPEED = 24;
const ROLL_SPEED_BASE = 300;
const COIN_FRAME_RATE = 18;
const PIN_BUMP_DISTANCE = 25;
const PIN_EXIT_DISTANCE = 150;
const PIN_BUMP_TIME = 0.15;
const PIN_EXIT_TIME = 0.4;
const IDLE_DEADLOCK = 0.7;
// 所有针仍在位时，开局落完后不必持续模拟封闭上仓里的堆叠抖动。
const INITIAL_SETTLE_TIME = 2.1;
const JAR_REACH = { left: -96, right: -40, top: -250, bottom: -330 };
const DEFAULT_COIN_COUNT = 150;
const MAX_COIN_COUNT = 150;
const MAX_COIN_DISPLAY_HEIGHT = 17;
const JAR_COIN_RADIUS = 3.5; // 入瓶后缩小接触半径，避免大批金币在瓶口上方堆回出口。
const GUIDE_THICKNESS = 8;
// Q2 漏斗出口两侧的交接点，使用 main 的本地坐标。
const OUTLET_LEFT = { x: -84, y: -184 };
const OUTLET_RIGHT = { x: -60, y: -183 };
// 上仓的取样范围；实际落点仍需避开场景轮廓。
const COIN_SPAWN = { left: -100, right: 102, bottom: 32, top: 172 };
const COIN_LOST_Y = -400;
const ROLL_WRITES_PER_FRAME = 24;
const POSITION_EPSILON_SQ = 0.04;

type Result = "win" | "lost" | "stuck";

interface Rod extends DropGate {
    node: cc.Node;
    sprite: cc.Sprite;
    base: cc.SpriteFrame;
    glow: cc.SpriteFrame | null;
    pulled: boolean;
}

interface Coin extends DropCoin {
    node: cc.Node;
    sprite: cc.Sprite;
    rollFrame: number;
    inJar: boolean;
    lost: boolean;
}

function findByName(root: cc.Node, name: string): cc.Node | null {
    if (!root) return null;
    if (root.name === name) return root;
    const kids = root.children;
    for (let i = 0; i < kids.length; i++) {
        const hit = findByName(kids[i], name);
        if (hit) return hit;
    }
    return null;
}

/** 链条不要零长度边，闭环由 loop 自己封口。 */
function chainPoints(raw: cc.Vec2[], offset: cc.Vec2): cc.Vec2[] {
    const out: cc.Vec2[] = [];
    for (let i = 0; i < raw.length; i++) {
        const p = cc.v2(raw[i].x + offset.x, raw[i].y + offset.y);
        const prev = out[out.length - 1];
        if (prev && prev.sub(p).mag() < 1.2) continue;
        out.push(p);
    }
    if (out.length > 2 && out[0].sub(out[out.length - 1]).mag() < 1.2) out.pop();
    return out;
}

function flashOn(t: number): boolean {
    const frame = Math.floor(t * 60) % 60;
    if (frame >= 40) return false;
    return Math.floor(frame / 10) % 2 === 1;
}

@ccclass
export default class Q2 extends cc.Component {
    /** 按播放顺序拖入 ident.10 至 ident.40 的 SpriteFrame。 */
    @property({ type: [cc.SpriteFrame], tooltip: "金币动画帧，按播放顺序排列" })
    private coinFrames: cc.SpriteFrame[] = [];

    /** 下标 0 对应 hg-1-glow，依次对应 hg-2-glow 等。 */
    @property({ type: [cc.SpriteFrame], tooltip: "拉针高亮图，按编号从 1 开始排列" })
    private pinGlowFrames: cc.SpriteFrame[] = [];

    @property({ type: cc.Integer, min: 1, max: MAX_COIN_COUNT, tooltip: "开局随机散落的金币数量" })
    private coinCount = DEFAULT_COIN_COUNT;

    @property({ min: 1, max: MAX_COIN_DISPLAY_HEIGHT, tooltip: "金币显示高度，不改变碰撞大小" })
    private coinDisplayHeight = 16;

    private main!: cc.Node;
    private coinRoot: cc.Node | null = null;
    private outlines: cc.Vec2[][] = [];
    private bottleOutline: cc.Vec2[] = [];
    private bottleCenterX = 0;
    private bottleMouthY = -Infinity;
    private wallGrid: Uint8Array = new Uint8Array(0);
    private rods: Rod[] = [];
    private coins: Coin[] = [];
    private frames: cc.SpriteFrame[] = [];
    private frameSizes = new Map<cc.SpriteFrame, cc.Size>();
    private glowOn: boolean | null = null;
    private readonly drop = new Q2Drop();
    private dropTime = 0;
    private sleeping = false;
    private pendingPulls = 0;
    private readonly restX = new Float64Array(MAX_COIN_COUNT);
    private readonly restY = new Float64Array(MAX_COIN_COUNT);
    private locked = true;
    private over = false;
    private ready = false;
    private idle = 0;
    private initialSettleTime = 0;
    private allInJarTime = 0;
    private frameWrites = 0;
    private frameCursor = 0;
    private tip!: cc.Label;
    private gridW = 0;
    private gridH = 0;
    private readonly gx0 = -170;
    private readonly gy0 = -380;
    private readonly gstep = 4;

    // 保留场景组件作为可编辑数据，不开启全局 Box2D。
    private disablePhysics(node: cc.Node) {
        for (const collider of node.getComponents(cc.PhysicsCollider)) collider.enabled = false;
        const body = node.getComponent(cc.RigidBody);
        if (body) body.enabled = false;
    }

    start() {
        const main = findByName(this.node, "main");
        if (!main) return;
        this.main = main;
        this.coinRoot = findByName(main, "金币");
        this.frames = (this.coinFrames || []).filter(frame => !!frame);
        this.buildUi();
        const pins = findByName(main, "针");
        if (!pins || !pins.childrenCount || !this.coinRoot || !this.coinRoot.childrenCount) {
            this.tip.string = "缺少针或金币节点，请检查 Q2 场景";
            this.tip.node.color = cc.color(176, 64, 48);
            cc.error("Q2: 请检查针和金币节点。");
            return;
        }
        this.prepareColliders();
        this.bindRods(pins);
        this.prepareCoinVisuals();
        this.bakeWallGrid();
        if (!this.outlines.length || !this.coins.length || !this.rods.length) {
            this.tip.string = "缺少有效的墙体、金币或针";
            return;
        }
        this.locked = false;
        this.ready = true;
    }

    /** 场景多边形仅作为轮廓数据，运行时按连续线段处理。 */
    private prepareColliders() {
        this.outlines = [];
        this.bottleOutline = [];
        this.readOutline(findByName(this.main, "walls"));
        this.readOutline(findByName(this.main, "bottle"), true);
        this.mountBottleGuides();
        for (const outline of this.outlines) this.drop.addOutline(outline);
        // 底部装饰齿槽不是独立出口。在齿顶连一段斜面，让松开挡针后的金币滑向左侧出口。
        this.drop.addOutline([cc.v2(-75, -147), cc.v2(103, -119)]);
    }

    private mountBottleGuides() {
        const y = this.bottleMouthY - GUIDE_THICKNESS;
        const mouth = this.bottleInteriorAt(y);
        if (!this.outlines[0] || !mouth || y >= Math.min(OUTLET_LEFT.y, OUTLET_RIGHT.y)) return;

        // 左右各一段实心边，仅补出口与瓶口间的空隙；两端搭进已有轮廓。
        const addGuide = (outlet: { x: number; y: number }, x: number, side: number) => {
            const outer = side * GUIDE_THICKNESS;
            const corners = [
                cc.v2(outlet.x, outlet.y), cc.v2(x, y),
                cc.v2(x + outer, y), cc.v2(outlet.x + outer, outlet.y),
            ];
            this.outlines.push(corners);
        };
        addGuide(OUTLET_LEFT, mouth.left + 1, -1);
        addGuide(OUTLET_RIGHT, mouth.right - 1, 1);
    }

    private readOutline(node: cc.Node | null, isBottle = false) {
        if (!node) {
            cc.error("Q2: 缺少碰撞节点");
            return;
        }
        const source = node.getComponent(cc.PhysicsPolygonCollider) || node.getComponent(cc.PolygonCollider);
        this.disablePhysics(node);
        if (!source || source.points.length < 3) {
            cc.error("Q2: 碰撞轮廓不足", node.name);
            return;
        }
        const points = chainPoints(source.points, source.offset || cc.v2(0, 0));
        const world = points.map(p => this.main.convertToNodeSpaceAR(node.convertToWorldSpaceAR(p)));
        this.outlines.push(world);
        if (isBottle) {
            this.bottleOutline = world;
            const top = node.getContentSize().height * (1 - node.anchorY);
            const mouth = this.main.convertToNodeSpaceAR(node.convertToWorldSpaceAR(cc.v2(0, top)));
            this.bottleCenterX = mouth.x;
            this.bottleMouthY = mouth.y;
        }
    }

    /** 按场景节点的编号，取编辑器中对应位置的高亮图。 */
    private glowFrame(node: cc.Node): cc.SpriteFrame | null {
        const match = /^(?:hg-)?(\d+)$/.exec(node.name);
        if (!match) return null;
        return this.pinGlowFrames[parseInt(match[1], 10) - 1] || null;
    }

    private bindRods(holder: cc.Node | null) {
        if (!holder) return;
        const kids = holder.children;
        for (let i = 0; i < kids.length; i++) {
            const node = kids[i];
            const sprite = node.getComponent(cc.Sprite);
            if (!sprite) continue;
            sprite.sizeMode = cc.Sprite.SizeMode.CUSTOM;
            const size = node.getContentSize();
            if (size.width < 2 || size.height < 2) continue;
            const collider = node.getComponent(cc.PhysicsBoxCollider);
            this.disablePhysics(node);
            if (!collider) {
                cc.error("Q2: 针缺少场景碰撞盒", node.name);
                continue;
            }
            const rod: Rod = {
                node,
                sprite,
                base: sprite.spriteFrame,
                glow: this.glowFrame(node),
                pulled: false,
                open: false,
            };
            const { width, height } = collider.size;
            const { x, y } = collider.offset;
            const corners = [cc.v2(x - width / 2, y - height / 2), cc.v2(x + width / 2, y - height / 2),
            cc.v2(x + width / 2, y + height / 2), cc.v2(x - width / 2, y + height / 2)];
            this.drop.addOutline(corners.map(p => this.main.convertToNodeSpaceAR(node.convertToWorldSpaceAR(p))), rod);
            this.rods.push(rod);
            node.on(cc.Node.EventType.TOUCH_END, () => this.pull(rod), this);
        }
    }

    private prepareCoinVisuals() {
        if (!this.coinRoot) return;
        const root = this.coinRoot;
        root.setSiblingIndex(this.main.childrenCount - 1);
        const nodes = root.children.slice();
        const template = nodes[0];
        const colliderTemplate = template.getComponent(cc.PhysicsCircleCollider);
        if (!colliderTemplate) {
            cc.error("Q2: 金币模板缺少圆形碰撞体");
            return;
        }
        const count = Math.max(1, Math.min(MAX_COIN_COUNT, Math.floor(this.coinCount)));
        const radius = colliderTemplate.radius;
        this.stripPhysics(template);
        const positions = this.sampleCoinPositions(count, radius);
        if (positions.length !== count) cc.error("Q2: 上仓空间不足，无法放下全部金币", positions.length, count);
        while (nodes.length < positions.length) {
            const clone = cc.instantiate(template);
            clone.name = `coin-${nodes.length + 1}`;
            nodes.push(clone);
        }
        for (let i = 0; i < nodes.length; i++) {
            const node = nodes[i];
            if (i >= positions.length) {
                node.active = false;
                continue;
            }
            const world = this.main.convertToWorldSpaceAR(positions[i]);
            node.setPosition(root.convertToNodeSpaceAR(world));
            if (!node.parent) node.parent = root;
            this.stripPhysics(node);
            const source = node.getComponent(cc.Sprite);
            if (!source) {
                cc.error("Q2: 金币缺少贴图组件", node.name);
                continue;
            }

            // 只改贴图显示尺寸，不缩放节点或圆形碰撞体。
            source.sizeMode = cc.Sprite.SizeMode.CUSTOM;
            source.trim = true;
            const frame = this.frames.length ? this.frames[i % this.frames.length] : source.spriteFrame;
            if (frame) this.setCoinFrame(source, frame);
            const pos = positions[i];
            this.coins.push({
                node, sprite: source, rollFrame: i, inJar: false, lost: false,
                x: pos.x, y: pos.y, previousX: pos.x, previousY: pos.y,
                vx: 0, vy: 0, radius, awake: true, still: 0
            });
        }
    }

    private stripPhysics(node: cc.Node) {
        const colliders = node.getComponents(cc.PhysicsCollider);
        for (let i = colliders.length - 1; i >= 0; i--) node.removeComponent(colliders[i]);
        const body = node.getComponent(cc.RigidBody);
        if (body) node.removeComponent(body);
    }

    private sampleCoinPositions(count: number, radius: number): cc.Vec2[] {
        const wall = this.outlines[0];
        if (!wall) return [];
        const positions: cc.Vec2[] = [];
        const clearance = radius + 1;
        const minGap = 2 * radius + 0.5;
        const minGapSq = minGap * minGap;
        const { left, right, bottom, top } = COIN_SPAWN;
        const place = (x: number, y: number) => {
            if (!this.fitsCoin(wall, x, y, clearance, positions, minGapSq)) return;
            positions.push(cc.v2(x, y));
        };
        // 先按网格铺满，避免 150 次随机拒绝采样在开局卡住主线程。
        for (let y = top - radius; y >= bottom + radius && positions.length < count; y -= minGap) {
            const shift = Math.round((top - y) / minGap) % 2 ? minGap * 0.5 : 0;
            for (let x = left + radius + shift; x <= right - radius && positions.length < count; x += minGap) {
                place(x, y);
            }
        }
        for (let attempt = 0; attempt < count * 40 && positions.length < count; attempt++) {
            place(left + Math.random() * (right - left), bottom + Math.random() * (top - bottom));
        }
        return positions;
    }

    private fitsCoin(wall: cc.Vec2[], x: number, y: number, clearance: number, positions: cc.Vec2[], minGapSq: number): boolean {
        let innerLeft = -Infinity;
        let innerRight = Infinity;
        for (let i = 0, j = wall.length - 1; i < wall.length; j = i++) {
            const a = wall[j];
            const b = wall[i];
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            if ((a.y > y) !== (b.y > y)) {
                const edgeX = a.x + (y - a.y) * dx / dy;
                if (edgeX < 0) innerLeft = Math.max(innerLeft, edgeX);
                else innerRight = Math.min(innerRight, edgeX);
            }
            const lenSq = dx * dx + dy * dy;
            const t = lenSq > 0 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / lenSq)) : 0;
            if ((x - a.x - t * dx) ** 2 + (y - a.y - t * dy) ** 2 < clearance * clearance) return false;
        }
        if (!isFinite(innerLeft) || !isFinite(innerRight) || x <= innerLeft || x >= innerRight) return false;
        for (let i = 0; i < positions.length; i++) {
            const placed = positions[i];
            if ((placed.x - x) ** 2 + (placed.y - y) ** 2 < minGapSq) return false;
        }
        return true;
    }

    private setCoinFrame(sprite: cc.Sprite, frame: cc.SpriteFrame) {
        let size = this.frameSizes.get(frame);
        if (!size) {
            const rect = frame.getRect();
            const height = Math.max(1, Math.min(MAX_COIN_DISPLAY_HEIGHT, this.coinDisplayHeight));
            size = cc.size(rect.width * height / Math.max(1, rect.height), height);
            this.frameSizes.set(frame, size);
        }
        sprite.spriteFrame = frame;
        sprite.node.setContentSize(size);
    }

    /** 回拉阶段继续承托；抽出动画开始的同一刻移除碰撞。 */
    private pull(rod: Rod) {
        if (this.locked || this.over || rod.pulled) return;
        const node = rod.node;
        rod.pulled = true;
        this.pendingPulls++;

        const parent = node.parent;
        const dir = this.pullDir(node);
        const p = node.getPosition();
        const localAt = (distance: number) => node.convertToNodeSpaceAR(parent.convertToWorldSpaceAR(
            cc.v2(p.x + dir.x * distance, p.y + dir.y * distance),
        ));
        const bump = localAt(-PIN_BUMP_DISTANCE);
        const out = localAt(PIN_EXIT_DISTANCE);
        const visual = new cc.Node("pull-visual");
        visual.parent = node;
        visual.setAnchorPoint(node.getAnchorPoint());
        visual.setContentSize(node.getContentSize());
        visual.color = node.color;
        const sprite = visual.addComponent(cc.Sprite);
        sprite.sizeMode = cc.Sprite.SizeMode.CUSTOM;
        sprite.spriteFrame = rod.sprite.spriteFrame;
        rod.sprite.enabled = false;

        cc.tween(visual)
            .to(PIN_BUMP_TIME, { x: bump.x, y: bump.y }, { easing: "sineInOut" })
            .call(() => {
                rod.open = true;
                this.pendingPulls--;
                this.sleeping = false;
                this.idle = 0;
                this.allInJarTime = 0;
                this.drop.wakeAbove(this.coins, this.bottleMouthY);
            })
            .to(PIN_EXIT_TIME, { x: out.x, y: out.y }, { easing: "sineOut" })
            .call(() => { node.active = false; })
            .start();
    }

    /** 素材拉环位于本地上端，沿杆轴向拉环抽出。 */
    private pullDir(node: cc.Node): cc.Vec2 {
        const parent = node.parent;
        const origin = parent.convertToNodeSpaceAR(node.convertToWorldSpaceAR(cc.v2(0, 0)));
        const handle = parent.convertToNodeSpaceAR(node.convertToWorldSpaceAR(cc.v2(0, 1)));
        const dx = handle.x - origin.x;
        const dy = handle.y - origin.y;
        const len = Math.sqrt(dx * dx + dy * dy) || 1;
        return cc.v2(dx / len, dy / len);
    }

    update(dt: number) {
        if (!this.ready || this.over) return;
        this.paintGlow();
        if (this.sleeping) return;
        this.dropTime = Math.min(this.dropTime + dt, PHYSICS_STEP * MAX_FRAME_STEPS);
        let simulated = 0;
        if (this.idle === 0) {
            for (let i = 0; i < this.coins.length; i++) {
                this.restX[i] = this.coins[i].x;
                this.restY[i] = this.coins[i].y;
            }
        }
        while (this.dropTime >= PHYSICS_STEP) {
            this.dropTime -= PHYSICS_STEP;
            simulated += PHYSICS_STEP;
            this.drop.step(this.coins, PHYSICS_STEP);
        }
        if (!simulated) return;
        this.frameWrites = 0;
        let lost = false;
        let allInJar = true;
        const total = this.coins.length;
        const start = total ? this.frameCursor % total : 0;
        for (let i = 0; i < total; i++) {
            const coin = this.coins[(start + i) % total];
            this.paintCoin(coin, simulated);
            lost = lost || coin.lost;
            allInJar = allInJar && coin.y <= this.bottleMouthY;
        }
        this.frameCursor = (start + ROLL_WRITES_PER_FRAME) % Math.max(1, total);
        if (this.pendingPulls) return;
        if (lost) {
            this.judge();
            return;
        }
        this.allInJarTime = allInJar ? this.allInJarTime + simulated : 0;
        if (this.allInJarTime >= IDLE_DEADLOCK) {
            this.allInJarTime = 0;
            this.judge(false);
            if (this.over) return;
        }
        this.idle += simulated;
        const initialHold = this.rods.every(rod => !rod.open);
        if (initialHold) this.initialSettleTime += simulated;
        const initialRest = initialHold && this.initialSettleTime >= INITIAL_SETTLE_TIME;
        if (!initialRest && this.idle < IDLE_DEADLOCK) return;
        this.idle = 0;
        // 用一段时间的净位移判断停稳，不让堆叠的微小抖动打断休眠。
        for (let i = 0; !initialRest && i < this.coins.length; i++) {
            const coin = this.coins[i];
            const dx = coin.x - this.restX[i];
            const dy = coin.y - this.restY[i];
            if (dx * dx + dy * dy > 4) return;
        }
        this.sleeping = true;
        this.dropTime = 0;
        for (const coin of this.coins) coin.vx = coin.vy = 0;
        this.judge();
    }

    private paintGlow() {
        const on = flashOn(cc.director.getTotalTime() / 1000);
        if (on === this.glowOn) return;
        this.glowOn = on;
        for (let i = 0; i < this.rods.length; i++) {
            const rod = this.rods[i];
            if (rod.pulled || !rod.sprite) continue;
            if (rod.glow) rod.sprite.spriteFrame = on ? rod.glow : rod.base;
            else rod.node.color = on ? cc.color(120, 255, 255) : cc.color(255, 255, 255);
        }
    }

    private paintCoin(coin: Coin, dt: number) {
        if (coin.lost) return;
        if (coin.y < COIN_LOST_Y) {
            coin.lost = true;
            coin.node.active = false;
            return;
        }
        if (coin.y <= this.bottleMouthY - coin.radius && coin.radius > JAR_COIN_RADIUS) {
            const cavity = this.bottleInteriorAt(coin.y);
            if (cavity && coin.x >= cavity.left && coin.x <= cavity.right) coin.radius = JAR_COIN_RADIUS;
        }
        if (!coin.awake) {
            if (coin.node.x !== coin.x || coin.node.y !== coin.y) coin.node.setPosition(coin.x, coin.y);
            return;
        }
        const dx = coin.x - coin.node.x;
        const dy = coin.y - coin.node.y;
        if (dx * dx + dy * dy >= POSITION_EPSILON_SQ) coin.node.setPosition(coin.x, coin.y);
        const speedSq = coin.vx * coin.vx + coin.vy * coin.vy;
        if (this.frames.length <= 1 || speedSq < ROLL_START_SPEED * ROLL_START_SPEED) return;
        const speed = Math.sqrt(speedSq);
        coin.rollFrame = (coin.rollFrame + dt * COIN_FRAME_RATE * speed / ROLL_SPEED_BASE) % this.frames.length;
        if (this.frameWrites >= ROLL_WRITES_PER_FRAME) return;
        const frame = this.frames[Math.floor(coin.rollFrame)];
        if (coin.sprite.spriteFrame === frame) return;
        this.frameWrites++;
        this.setCoinFrame(coin.sprite, frame);
    }

    private bottleInteriorAt(y: number): { left: number; right: number } | null {
        const outline = this.bottleOutline;
        const center = this.bottleCenterX;
        let left = -Infinity;
        let right = Infinity;
        let crossings = 0;
        for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
            const a = outline[j];
            const b = outline[i];
            if ((a.y > y) === (b.y > y)) continue;
            const x = a.x + (b.x - a.x) * (y - a.y) / (b.y - a.y);
            if (x <= center) {
                crossings++;
                left = Math.max(left, x);
            } else {
                right = Math.min(right, x);
            }
        }
        // 中心落在瓶壁材料内或不在瓶身截面上时，不视为瓶腔。
        return crossings > 0 && crossings % 2 === 0 && right < Infinity ? { left, right } : null;
    }

    private captureJar(coin: Coin, p: { x: number; y: number }) {
        const cavity = p.y <= this.bottleMouthY ? this.bottleInteriorAt(p.y) : null;
        coin.inJar = !!cavity && p.x >= cavity.left && p.x <= cavity.right;
    }

    private judge(allowStuck = true) {
        let collected = 0;
        let lost = false;
        for (let i = 0; i < this.coins.length; i++) {
            const coin = this.coins[i];
            if (coin.lost) {
                lost = true;
                continue;
            }
            this.captureJar(coin, coin);
            if (coin.inJar) collected++;
        }
        if (lost) this.finish("lost", collected);
        else if (collected === this.coins.length) this.finish("win", collected);
        else if (allowStuck && (this.rods.every(rod => rod.open) || !this.reachesExit())) this.finish("stuck", collected);
    }

    /**
     * 针只挡路、不搭桥。把剩余针全部抽掉仍到不了喷口，
     * 就说明之后任何顺序都无法进瓶。
     */
    private reachesExit(): boolean {
        const reach = this.flood();
        for (let y = JAR_REACH.top; y >= JAR_REACH.bottom; y -= this.gstep) {
            for (let x = JAR_REACH.left; x <= JAR_REACH.right; x += this.gstep) {
                const c = this.cell(x, y);
                if (c && reach[c.i]) return true;
            }
        }
        return false;
    }

    /** 将场景墙体和瓶壁转换为网格，供后续连通性搜索使用。 */
    private bakeWallGrid() {
        this.gridW = Math.ceil(360 / this.gstep);
        this.gridH = Math.ceil(580 / this.gstep);
        this.wallGrid = new Uint8Array(this.gridW * this.gridH);
        if (!this.outlines.length) {
            cc.error("Q2: 缺少墙体碰撞节点");
            return;
        }
        for (let i = 0; i < this.outlines.length; i++) this.stamp(this.wallGrid, this.outlines[i]);
    }

    private cell(x: number, y: number): { x: number; y: number; i: number } | null {
        const gx = Math.floor((x - this.gx0) / this.gstep);
        const gy = Math.floor((y - this.gy0) / this.gstep);
        if (gx < 0 || gy < 0 || gx >= this.gridW || gy >= this.gridH) return null;
        return { x: gx, y: gy, i: gy * this.gridW + gx };
    }

    /** 从未收集的金币出发，标记不穿过墙体即可到达的网格。 */
    private flood(): Uint8Array {
        const blocked = new Uint8Array(this.wallGrid);
        const seen = new Uint8Array(blocked.length);
        const stack: number[] = [];
        for (let i = 0; i < this.coins.length; i++) {
            const coin = this.coins[i];
            if (coin.inJar || coin.lost) continue;
            const p = coin.node.getPosition();
            const c = this.cell(p.x, p.y);
            if (!c) continue;
            if (blocked[c.i]) {
                const near = this.nearOpen(blocked, c.x, c.y);
                if (near >= 0) stack.push(near);
            } else {
                stack.push(c.i);
            }
        }
        while (stack.length) {
            const i = stack.pop();
            if (i === undefined || seen[i] || blocked[i]) continue;
            seen[i] = 1;
            const x = i % this.gridW;
            const y = (i - x) / this.gridW;
            if (x > 0) stack.push(i - 1);
            if (x + 1 < this.gridW) stack.push(i + 1);
            if (y > 0) stack.push(i - this.gridW);
            if (y + 1 < this.gridH) stack.push(i + this.gridW);
        }
        return seen;
    }

    private nearOpen(blocked: Uint8Array, x: number, y: number): number {
        for (let dy = -2; dy <= 2; dy++) {
            for (let dx = -2; dx <= 2; dx++) {
                const nx = x + dx;
                const ny = y + dy;
                if (nx < 0 || ny < 0 || nx >= this.gridW || ny >= this.gridH) continue;
                const i = ny * this.gridW + nx;
                if (!blocked[i]) return i;
            }
        }
        return -1;
    }

    private stamp(grid: Uint8Array, corners: { x: number; y: number }[]) {
        let minX = corners[0].x;
        let maxX = corners[0].x;
        let minY = corners[0].y;
        let maxY = corners[0].y;
        for (let i = 1; i < corners.length; i++) {
            minX = Math.min(minX, corners[i].x);
            maxX = Math.max(maxX, corners[i].x);
            minY = Math.min(minY, corners[i].y);
            maxY = Math.max(maxY, corners[i].y);
        }
        const x0 = Math.max(0, Math.floor((minX - this.gx0) / this.gstep));
        const x1 = Math.min(this.gridW - 1, Math.floor((maxX - this.gx0) / this.gstep));
        const y0 = Math.max(0, Math.floor((minY - this.gy0) / this.gstep));
        const y1 = Math.min(this.gridH - 1, Math.floor((maxY - this.gy0) / this.gstep));
        for (let gy = y0; gy <= y1; gy++) {
            for (let gx = x0; gx <= x1; gx++) {
                const x = this.gx0 + (gx + 0.5) * this.gstep;
                const y = this.gy0 + (gy + 0.5) * this.gstep;
                let inside = false;
                for (let a = 0, b = corners.length - 1; a < corners.length; b = a++) {
                    const p = corners[a];
                    const q = corners[b];
                    if ((p.y > y) !== (q.y > y) && x < (q.x - p.x) * (y - p.y) / (q.y - p.y) + p.x) {
                        inside = !inside;
                    }
                }
                if (inside) grid[gy * this.gridW + gx] = 1;
            }
        }
    }

    private finish(result: Result, collected: number) {
        if (this.over) return;
        this.over = true;
        this.locked = true;
        const win = result === "win";
        const title = win ? "通关成功" : "挑战失败";
        const titleColor = win ? cc.color(69, 130, 68) : cc.color(176, 64, 48);
        const detail = win ? "所有金币都已入瓶"
            : result === "lost" ? "有金币掉出了场景" : "剩余金币无法入瓶";
        this.tip.string = title;
        this.tip.node.color = titleColor;

        const overlay = new cc.Node("settlement");
        overlay.parent = this.tip.node.parent;
        const size = this.node.getContentSize();
        overlay.setContentSize(size);
        overlay.addComponent(cc.BlockInputEvents);
        const backdrop = overlay.addComponent(cc.Graphics);
        backdrop.fillColor = cc.color(22, 17, 35, 150);
        backdrop.rect(-size.width / 2, -size.height / 2, size.width, size.height);
        backdrop.fill();

        const panel = new cc.Node("result-panel");
        panel.parent = overlay;
        const background = panel.addComponent(cc.Graphics);
        background.fillColor = cc.color(255, 248, 236);
        background.roundRect(-176, -114, 352, 228, 20);
        background.fill();
        this.addLabel(panel, "title", title, 0, 66, 36, titleColor);
        this.addLabel(panel, "detail", detail, 0, 20, 22, cc.color(91, 73, 62));
        this.addLabel(panel, "score", `已入瓶 ${collected} / ${this.coins.length}`, 0, -13, 24, cc.color(91, 73, 62));
        this.addRestartButton(panel, "再玩一次", 0, -69, 160, cc.color(255, 207, 114));
    }

    private addLabel(parent: cc.Node, name: string, text: string, x: number, y: number, fontSize: number, color: cc.Color): cc.Label {
        const node = new cc.Node(name);
        node.parent = parent;
        node.setPosition(x, y);
        node.color = color;
        const label = node.addComponent(cc.Label);
        label.string = text;
        label.fontSize = fontSize;
        label.lineHeight = fontSize + 4;
        return label;
    }

    private addRestartButton(parent: cc.Node, text: string, x: number, y: number, width: number, color: cc.Color) {
        const btn = new cc.Node("restart");
        btn.parent = parent;
        btn.setPosition(x, y);
        btn.setContentSize(width, 44);
        const g = btn.addComponent(cc.Graphics);
        g.fillColor = color;
        g.roundRect(-width / 2, -22, width, 44, 10);
        g.fill();
        this.addLabel(btn, "text", text, 0, 0, 26, cc.color(70, 55, 40));
        btn.on(cc.Node.EventType.TOUCH_END, () => cc.director.loadScene("Q2"), this);
    }

    private buildUi() {
        const ui = new cc.Node("ui");
        ui.parent = this.node;
        this.tip = this.addLabel(ui, "tip", "点发光的针抽出", 0, 286, 28, cc.color(70, 60, 48));
        this.addRestartButton(ui, "重开", 390, 286, 120, cc.color(255, 248, 236, 230));
    }
}
