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

export interface DropCoin {
    x: number;
    y: number;
    vx: number;
    vy: number;
    radius: number;
    lost: boolean;
    previousX: number;
    previousY: number;
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
    private readonly links = new Int16Array(140);
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

    // 固定步重力；位置修正也走扫描碰撞，避免挤成一团时把金币挤到挡针背面。
    step(coins: ReadonlyArray<DropCoin>, dt: number): number {
        for (const coin of coins) {
            if (coin.lost) continue;
            coin.previousX = coin.x;
            coin.previousY = coin.y;
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
        for (let pass = 0; pass < 4; pass++) this.separate(coins);
        let maxMotionSq = 0;
        for (const coin of coins) {
            if (coin.lost) continue;
            const dx = coin.x - coin.previousX;
            const dy = coin.y - coin.previousY;
            // 位置迭代消掉堆叠压力，不把分离位移变成下一步的动能。
            coin.vx = this.constrainedVelocity(coin.vx, dx / dt) * 0.98;
            coin.vy = this.constrainedVelocity(coin.vy, dy / dt) * 0.98;
            maxMotionSq = Math.max(maxMotionSq, dx * dx + dy * dy);
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
            if (a.lost) continue;
            const gx = column(a.x);
            const gy = row(a.y);
            for (let y = Math.max(0, gy - 1); y <= Math.min(ROWS - 1, gy + 1); y++) {
                for (let x = Math.max(0, gx - 1); x <= Math.min(COLS - 1, gx + 1); x++) {
                    for (let j = this.heads[y * COLS + x]; j > i; j = this.links[j]) {
                        this.separatePair(a, coins[j]);
                    }
                }
            }
        }
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
        // 允许少量接触重叠，避免密集堆叠的修正把相邻金币来回弹开。
        const correction = Math.min(0.45, (gap - dist) * 0.35);
        // 同一道实体薄边两侧的金币不该彼此支撑：推不到接触方向就不传递速度。
        const ax = a.x;
        const ay = a.y;
        const bx = b.x;
        const by = b.y;
        this.move(a, -nx * correction, -ny * correction, false);
        this.move(b, nx * correction, ny * correction, false);
        if ((b.x - bx - a.x + ax) * nx + (b.y - by - a.y + ay) * ny < SKIN) return;
        const closing = (a.vx - b.vx) * nx + (a.vy - b.vy) * ny;
        if (closing <= 0) return;
        const impulse = closing * 0.5;
        a.vx -= nx * impulse;
        a.vy -= ny * impulse;
        b.vx += nx * impulse;
        b.vy += ny * impulse;
    }

    private move(coin: DropCoin, dx: number, dy: number, slide: boolean) {
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
