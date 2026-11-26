// Q2 专用：在 main 的本地坐标里求解，不依赖 Cocos 物理世界。
const CELL = 16;
const GRID_LEFT = -256;
const GRID_BOTTOM = -448;
const COLS = 32;
const ROWS = 42;
const SKIN = 0.015;
const EPSILON = 1e-8;
const GRAVITY = 1200;
const MAX_SPEED = 300;
const MAX_SPEED_SQ = MAX_SPEED * MAX_SPEED;
const SLEEP_SPEED = 6;
const SLEEP_SPEED_SQ = SLEEP_SPEED * SLEEP_SPEED;
const SLEEP_FRAMES = 6;
const WAKE_PAD = 2;
const COIN_CAP = 160;

export interface DropCoin {
    x: number;
    y: number;
    vx: number;
    vy: number;
    radius: number;
    lost: boolean;
    previousX: number;
    previousY: number;
    awake: boolean;
    still: number;
}

export interface DropGate { open: boolean; }
interface Point { x: number; y: number; }
interface Edge {
    ax: number; ay: number; bx: number; by: number;
    tx: number; ty: number; length: number;
    left: number; right: number; bottom: number; top: number;
    gate?: DropGate;
    visited: number;
}

function column(x: number) { return Math.floor((x - GRID_LEFT) / CELL); }
function row(y: number) { return Math.floor((y - GRID_BOTTOM) / CELL); }

export class Q2Drop {
    private readonly edges: Edge[][] = Array.from({ length: COLS * ROWS }, () => []);
    private readonly heads = new Int16Array(COLS * ROWS);
    private links = new Int16Array(COIN_CAP);
    private readonly occupied: number[] = [];
    private queryId = 0;
    private hitTime = 1;
    private hitX = 0;
    private hitY = 0;

    constructor() { this.heads.fill(-1); }

    addOutline(points: ReadonlyArray<Point>, gate?: DropGate) {
        if (points.length < 2) return;
        const first = points.length === 2 ? 1 : 0;
        for (let i = first, j = points.length - 1 - first; i < points.length; j = i++) {
            const a = points[j];
            const b = points[i];
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const length = Math.sqrt(dx * dx + dy * dy);
            if (length < EPSILON) continue;
            const edge: Edge = {
                ax: a.x, ay: a.y, bx: b.x, by: b.y, tx: dx / length, ty: dy / length, length,
                left: Math.min(a.x, b.x), right: Math.max(a.x, b.x),
                bottom: Math.min(a.y, b.y), top: Math.max(a.y, b.y), gate, visited: 0,
            };
            for (let y = Math.max(0, row(edge.bottom)); y <= Math.min(ROWS - 1, row(edge.top)); y++) {
                for (let x = Math.max(0, column(edge.left)); x <= Math.min(COLS - 1, column(edge.right)); x++) {
                    this.edges[y * COLS + x].push(edge);
                }
            }
        }
    }

    /** 瓶外的金币重新参与求解；已经进瓶并睡着的不叫醒。 */
    wakeAbove(coins: ReadonlyArray<DropCoin>, y: number) {
        for (let i = 0; i < coins.length; i++) {
            const coin = coins[i];
            if (coin.lost || coin.y < y) continue;
            coin.awake = true;
            coin.still = 0;
        }
    }

    private ensure(count: number) {
        if (count <= this.links.length) return;
        this.links = new Int16Array(count);
    }

    // 睡着的金币不积分。堆叠修正不再做连续扫描，只有贴着边的金币才离散推出。
    step(coins: ReadonlyArray<DropCoin>, dt: number): number {
        this.ensure(coins.length);
        let awake = 0;
        for (let i = 0; i < coins.length; i++) {
            const coin = coins[i];
            if (coin.lost) continue;
            coin.previousX = coin.x;
            coin.previousY = coin.y;
            if (!coin.awake) continue;
            awake++;
            coin.vx *= 0.995;
            coin.vy -= GRAVITY * dt;
            const speedSq = coin.vx * coin.vx + coin.vy * coin.vy;
            if (speedSq > MAX_SPEED_SQ) {
                const scale = MAX_SPEED / Math.sqrt(speedSq);
                coin.vx *= scale;
                coin.vy *= scale;
            }
            this.move(coin, coin.vx * dt, coin.vy * dt, true);
        }
        if (!awake) return 0;
        for (let pass = 0; pass < 4; pass++) this.separate(coins);
        let maxMotionSq = 0;
        for (let i = 0; i < coins.length; i++) {
            const coin = coins[i];
            if (coin.lost || !coin.awake) continue;
            const dx = coin.x - coin.previousX;
            const dy = coin.y - coin.previousY;
            coin.vx = this.constrainedVelocity(coin.vx, dx / dt) * 0.98;
            coin.vy = this.constrainedVelocity(coin.vy, dy / dt) * 0.98;
            const speedSq = coin.vx * coin.vx + coin.vy * coin.vy;
            if (speedSq < SLEEP_SPEED_SQ) {
                coin.still++;
                if (coin.still >= SLEEP_FRAMES) coin.awake = false;
            } else {
                coin.still = 0;
            }
            if (dx * dx + dy * dy > maxMotionSq) maxMotionSq = dx * dx + dy * dy;
        }
        return maxMotionSq;
    }

    private constrainedVelocity(velocity: number, displacementSpeed: number): number {
        if (velocity * displacementSpeed <= 0) return 0;
        return Math.sign(velocity) * Math.min(Math.abs(velocity), Math.abs(displacementSpeed));
    }

    private separate(coins: ReadonlyArray<DropCoin>) {
        for (const index of this.occupied) this.heads[index] = -1;
        this.occupied.length = 0;
        for (let i = 0; i < coins.length; i++) {
            const coin = coins[i];
            this.links[i] = -1;
            if (coin.lost) continue;
            const x = column(coin.x);
            const y = row(coin.y);
            if (x < 0 || x >= COLS || y < 0 || y >= ROWS) continue;
            const cell = y * COLS + x;
            if (this.heads[cell] < 0) this.occupied.push(cell);
            this.links[i] = this.heads[cell];
            this.heads[cell] = i;
        }
        for (let i = 0; i < coins.length; i++) {
            const a = coins[i];
            if (a.lost || !a.awake) continue;
            const mx = a.x - a.previousX;
            const my = a.y - a.previousY;
            const stirring = mx * mx + my * my > 0.04;
            const gx = column(a.x);
            const gy = row(a.y);
            for (let y = Math.max(0, gy - 1); y <= Math.min(ROWS - 1, gy + 1); y++) {
                for (let x = Math.max(0, gx - 1); x <= Math.min(COLS - 1, gx + 1); x++) {
                    for (let j = this.heads[y * COLS + x]; j >= 0; j = this.links[j]) {
                        if (j === i) continue;
                        const b = coins[j];
                        if (b.awake) {
                            if (j < i) continue;
                        } else if (stirring) {
                            this.wakeSupported(a, b);
                        }
                        this.separatePair(a, b);
                    }
                }
            }
        }
    }

    /** 正在下落的金币叫醒可能压在它上面的邻居，堆叠才会跟着塌，而不是整仓一起醒。 */
    private wakeSupported(mover: DropCoin, other: DropCoin) {
        const dy = other.y - mover.y;
        if (dy < -1) return;
        const dx = other.x - mover.x;
        const reach = mover.radius + other.radius + WAKE_PAD;
        if (dx * dx + dy * dy > reach * reach) return;
        other.awake = true;
        other.still = 0;
    }

    private separatePair(a: DropCoin, b: DropCoin) {
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const gap = a.radius + b.radius - 0.45;
        const distSq = dx * dx + dy * dy;
        if (distSq >= gap * gap) return;
        const dist = Math.sqrt(distSq);
        const nx = dist > EPSILON ? dx / dist : 1;
        const ny = dist > EPSILON ? dy / dist : 0;
        const correction = Math.min(0.45, (gap - dist) * 0.35);
        const ax = a.x;
        const ay = a.y;
        const bx = b.x;
        const by = b.y;
        this.nudge(a, -nx * correction, -ny * correction);
        this.nudge(b, nx * correction, ny * correction);
        if (!a.awake) { a.awake = true; a.still = 0; }
        if (!b.awake) { b.awake = true; b.still = 0; }
        if ((b.x - bx - a.x + ax) * nx + (b.y - by - a.y + ay) * ny < SKIN) return;
        const closing = (a.vx - b.vx) * nx + (a.vy - b.vy) * ny;
        if (closing <= 0) return;
        const impulse = closing * 0.5;
        a.vx -= nx * impulse;
        a.vy -= ny * impulse;
        b.vx += nx * impulse;
        b.vy += ny * impulse;
    }

    /** 修正量小于针厚，离散推出不会穿到挡针背面；空单元格直接跳过。 */
    private nudge(coin: DropCoin, dx: number, dy: number) {
        coin.x += dx;
        coin.y += dy;
        if (this.nearEdge(coin.x, coin.y, coin.radius)) this.clampOut(coin);
    }

    private nearEdge(x: number, y: number, radius: number): boolean {
        const x0 = Math.max(0, column(x - radius));
        const x1 = Math.min(COLS - 1, column(x + radius));
        const y0 = Math.max(0, row(y - radius));
        const y1 = Math.min(ROWS - 1, row(y + radius));
        for (let gy = y0; gy <= y1; gy++) {
            for (let gx = x0; gx <= x1; gx++) {
                if (this.edges[gy * COLS + gx].length) return true;
            }
        }
        return false;
    }

    private clampOut(coin: DropCoin) {
        const radius = coin.radius;
        for (let iter = 0; iter < 2; iter++) {
            const id = ++this.queryId;
            let pushed = false;
            const x0 = Math.max(0, column(coin.x - radius));
            const x1 = Math.min(COLS - 1, column(coin.x + radius));
            const y0 = Math.max(0, row(coin.y - radius));
            const y1 = Math.min(ROWS - 1, row(coin.y + radius));
            for (let gy = y0; gy <= y1; gy++) {
                for (let gx = x0; gx <= x1; gx++) {
                    const bucket = this.edges[gy * COLS + gx];
                    for (let e = 0; e < bucket.length; e++) {
                        const edge = bucket[e];
                        if (edge.visited === id || (edge.gate && edge.gate.open)) continue;
                        edge.visited = id;
                        if (this.pushEdge(coin, edge)) pushed = true;
                    }
                }
            }
            if (!pushed) break;
        }
    }

    private pushEdge(coin: DropCoin, edge: Edge): boolean {
        let along = (coin.x - edge.ax) * edge.tx + (coin.y - edge.ay) * edge.ty;
        if (along < 0) along = 0;
        else if (along > edge.length) along = edge.length;
        const cx = edge.ax + edge.tx * along;
        const cy = edge.ay + edge.ty * along;
        let dx = coin.x - cx;
        let dy = coin.y - cy;
        const distSq = dx * dx + dy * dy;
        const radius = coin.radius;
        if (distSq >= radius * radius) return false;
        const dist = Math.sqrt(distSq);
        if (dist > EPSILON) {
            const scale = (radius + SKIN - dist) / dist;
            coin.x += dx * scale;
            coin.y += dy * scale;
            dx /= dist;
            dy /= dist;
        } else {
            dx = -edge.ty;
            dy = edge.tx;
            coin.x += dx * (radius + SKIN);
            coin.y += dy * (radius + SKIN);
        }
        const approach = coin.vx * dx + coin.vy * dy;
        if (approach < 0) {
            coin.vx -= approach * dx;
            coin.vy -= approach * dy;
        }
        return true;
    }

    private move(coin: DropCoin, dx: number, dy: number, slide: boolean) {
        const lengthSq = dx * dx + dy * dy;
        if (lengthSq < EPSILON) return;
        // 扫掠圆的外接圆里没有边，就不可能撞上墙或针。
        const length = Math.sqrt(lengthSq);
        if (!this.nearEdge(coin.x + dx * 0.5, coin.y + dy * 0.5, coin.radius + length * 0.5)) {
            coin.x += dx;
            coin.y += dy;
            return;
        }
        for (let i = 0; i < (slide ? 3 : 1); i++) {
            const lengthSq = dx * dx + dy * dy;
            if (lengthSq < EPSILON) break;
            this.sweep(coin.x, coin.y, dx, dy, coin.radius);
            if (this.hitTime === 1) {
                coin.x += dx;
                coin.y += dy;
                break;
            }
            const t = Math.max(0, this.hitTime - SKIN / Math.sqrt(lengthSq));
            coin.x += dx * t;
            coin.y += dy * t;
            if (!slide) break;
            const nx = this.hitX;
            const ny = this.hitY;
            const approach = coin.vx * nx + coin.vy * ny;
            if (approach < 0) {
                coin.vx = (coin.vx - approach * nx) * 0.99;
                coin.vy = (coin.vy - approach * ny) * 0.99;
            }
            const inward = dx * nx + dy * ny;
            dx = (dx - inward * nx) * (1 - t);
            dy = (dy - inward * ny) * (1 - t);
        }
    }

    private sweep(x: number, y: number, dx: number, dy: number, radius: number) {
        this.hitTime = 1;
        const id = ++this.queryId;
        const left = Math.min(x, x + dx) - radius;
        const right = Math.max(x, x + dx) + radius;
        const bottom = Math.min(y, y + dy) - radius;
        const top = Math.max(y, y + dy) + radius;
        const lengthSq = dx * dx + dy * dy;
        for (let gy = Math.max(0, row(bottom)); gy <= Math.min(ROWS - 1, row(top)); gy++) {
            for (let gx = Math.max(0, column(left)); gx <= Math.min(COLS - 1, column(right)); gx++) {
                const bucket = this.edges[gy * COLS + gx];
                for (const edge of bucket) {
                    if (edge.visited === id || (edge.gate && edge.gate.open)) continue;
                    edge.visited = id;
                    if (edge.right < left || edge.left > right || edge.top < bottom || edge.bottom > top) continue;
                    this.sweepEdge(edge, x, y, dx, dy, radius, lengthSq);
                }
            }
        }
    }

    // 圆扫过线段等价于点扫过胶囊：先测长边，再测两个圆端，取最早命中。
    private sweepEdge(edge: Edge, x: number, y: number, dx: number, dy: number, radius: number, lengthSq: number) {
        const sx = x - edge.ax;
        const sy = y - edge.ay;
        let nx = -edge.ty;
        let ny = edge.tx;
        let distance = sx * nx + sy * ny;
        if (distance < 0) {
            nx = -nx;
            ny = -ny;
            distance = -distance;
        }
        const approach = dx * nx + dy * ny;
        if (approach < -EPSILON) {
            const t = Math.max(0, (radius - distance) / approach);
            const along = (sx + dx * t) * edge.tx + (sy + dy * t) * edge.ty;
            if (t < this.hitTime && along >= 0 && along <= edge.length) this.hit(t, nx, ny);
        }
        this.sweepTip(sx, sy, dx, dy, radius, lengthSq);
        this.sweepTip(x - edge.bx, y - edge.by, dx, dy, radius, lengthSq);
    }

    private sweepTip(x: number, y: number, dx: number, dy: number, radius: number, lengthSq: number) {
        const toward = x * dx + y * dy;
        if (toward >= -EPSILON) return;
        const discriminant = toward * toward - lengthSq * (x * x + y * y - radius * radius);
        if (discriminant <= 0) return;
        const t = Math.max(0, (-toward - Math.sqrt(discriminant)) / lengthSq);
        if (t >= this.hitTime) return;
        const nx = x + t * dx;
        const ny = y + t * dy;
        const distance = Math.sqrt(nx * nx + ny * ny);
        if (distance > EPSILON) this.hit(t, nx / distance, ny / distance);
    }

    private hit(t: number, nx: number, ny: number) {
        this.hitTime = t;
        this.hitX = nx;
        this.hitY = ny;
    }
}
