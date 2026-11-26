/**
界面上有三个输入框，分别对应 X,Y,Z 的值，请实现 {@link Q1.onGenerateBtnClick} 函数，生成一个 10 × 10 的可控随机矩阵，并显示到界面上，矩阵要求如下：
1. {@link COLORS} 中预定义了 5 种颜色
2. 每个点可选 5 种颜色中的 1 种
3. 按照从左到右，从上到下的顺序，依次为每个点生成颜色，(0, 0)为左上⻆点，(9, 9)为右下⻆点，(0, 9)为右上⻆点
4. 点(0, 0)随机在 5 种颜色中选取
5. 其他各点的颜色计算规则如下，设目标点坐标为(m, n）：
    a. (m, n - 1)所属颜色的概率为基准概率加 X%
    b. (m - 1, n)所属颜色的概率为基准概率加 Y%
    c. 如果(m, n - 1)和(m - 1, n)同色，则该颜色的概率为基准概率加 Z%
    d. 其他颜色平分剩下的概率
*/

const { ccclass, property } = cc._decorator;

const COLORS = [
    cc.Color.RED,
    cc.Color.GREEN,
    cc.Color.BLUE,
    cc.Color.YELLOW,
    cc.Color.ORANGE,
];

// 每个格子的大小
const GRID_ITEM_SIZE = 60;
const GRID_COUNT = 10;
/** 五种颜色等概率时的基准概率。输入框里的 X/Y/Z 按百分数理解，10 表示 +10%。 */
const BASE_PROBABILITY = 1 / COLORS.length;

@ccclass
export default class Q1 extends cc.Component {

    @property(cc.EditBox)
    private xEditBox: cc.EditBox = null;

    @property(cc.EditBox)
    private yEditBox: cc.EditBox = null;

    @property(cc.EditBox)
    private zEditBox: cc.EditBox = null;

    @property(cc.Node)
    private gridRootNode: cc.Node = null;

    @property(cc.Prefab)
    private gridItemPrefab: cc.Prefab = null;

    /** 首次生成后常驻。再次生成只改显隐和颜色，不再创建或销毁。 */
    private cells: cc.Node[] = null;
    private pendingMatrix: number[][] = null;

    public onGenerateBtnClick() {
        if (!this.gridRootNode || !this.gridItemPrefab) {
            return;
        }
        const bonusX = readPercent(this.xEditBox);
        const bonusY = readPercent(this.yEditBox);
        const bonusZ = readPercent(this.zEditBox);
        this.refreshMatrix(buildMatrix(bonusX, bonusY, bonusZ));
    }

    onDestroy() {
        this.unschedule(this.revealCells);
    }

    /** 先隐藏旧结果，下一帧再把新颜色刷回同一批格子。 */
    private refreshMatrix(matrix: number[][]) {
        this.ensureCells();
        this.pendingMatrix = matrix;
        this.setCellsActive(false);
        this.unschedule(this.revealCells);
        this.scheduleOnce(this.revealCells, 0);
    }

    private revealCells() {
        if (!this.cells || !this.pendingMatrix) {
            return;
        }
        for (let row = 0; row < GRID_COUNT; row++) {
            for (let column = 0; column < GRID_COUNT; column++) {
                this.cells[row * GRID_COUNT + column].color = COLORS[this.pendingMatrix[row][column]];
            }
        }
        this.setCellsActive(true);
    }

    private setCellsActive(active: boolean) {
        if (!this.cells) {
            return;
        }
        for (let i = 0; i < this.cells.length; i++) {
            this.cells[i].active = active;
        }
    }

    private ensureCells() {
        if (this.cells) {
            return;
        }
        const placeholders = this.gridRootNode.children.slice();
        for (let i = 0; i < placeholders.length; i++) {
            placeholders[i].active = false;
        }

        const size = this.gridRootNode.getContentSize();
        const originX = -size.width * this.gridRootNode.anchorX + GRID_ITEM_SIZE * 0.5;
        const originY = size.height * (1 - this.gridRootNode.anchorY) - GRID_ITEM_SIZE * 0.5;
        this.cells = [];
        for (let row = 0; row < GRID_COUNT; row++) {
            for (let column = 0; column < GRID_COUNT; column++) {
                const item = cc.instantiate(this.gridItemPrefab);
                item.parent = this.gridRootNode;
                item.active = false;
                item.setContentSize(GRID_ITEM_SIZE, GRID_ITEM_SIZE);
                item.setPosition(originX + column * GRID_ITEM_SIZE, originY - row * GRID_ITEM_SIZE);
                this.cells.push(item);
            }
        }
    }
}

/** 输入按百分数换算。空值或非数字按 0 处理。 */
function readPercent(editBox: cc.EditBox): number {
    if (!editBox) {
        return 0;
    }
    const value = parseFloat(editBox.string);
    return isNaN(value) ? 0 : value / 100;
}

/**
 * 行优先生成。matrix[m][n] 是颜色下标。
 * 左邻是 (m, n-1)，上邻是 (m-1, n)；边界上不存在的邻居不参与加权。
 * 两个邻居同色时只使用 Z，不再叠加 X 和 Y。
 */
function buildMatrix(bonusX: number, bonusY: number, bonusZ: number): number[][] {
    const matrix: number[][] = [];
    for (let row = 0; row < GRID_COUNT; row++) {
        const line: number[] = [];
        for (let column = 0; column < GRID_COUNT; column++) {
            if (row === 0 && column === 0) {
                line.push(randomIndex(COLORS.length));
                continue;
            }
            const left = column > 0 ? line[column - 1] : -1;
            const up = row > 0 ? matrix[row - 1][column] : -1;
            line.push(pickIndex(probabilitiesAt(left, up, bonusX, bonusY, bonusZ)));
        }
        matrix.push(line);
    }
    return matrix;
}

/**
 * 指定颜色拿到「基准概率 + 加成」的绝对概率，其余颜色平分剩余概率。
 * 加成过大导致指定概率之和超过 1 时，按比例压回 1，其余颜色概率为 0。
 */
function probabilitiesAt(left: number, up: number, bonusX: number, bonusY: number, bonusZ: number): number[] {
    const count = COLORS.length;
    const probability: number[] = [];
    const fixed: boolean[] = [];
    for (let i = 0; i < count; i++) {
        probability.push(0);
        fixed.push(false);
    }

    if (left >= 0 && up >= 0 && left === up) {
        probability[left] = clamp01(BASE_PROBABILITY + bonusZ);
        fixed[left] = true;
    } else {
        if (left >= 0) {
            probability[left] = clamp01(BASE_PROBABILITY + bonusX);
            fixed[left] = true;
        }
        if (up >= 0) {
            probability[up] = clamp01(BASE_PROBABILITY + bonusY);
            fixed[up] = true;
        }
    }

    let fixedSum = 0;
    let fixedCount = 0;
    for (let i = 0; i < count; i++) {
        if (!fixed[i]) {
            continue;
        }
        fixedSum += probability[i];
        fixedCount++;
    }
    if (fixedSum > 1) {
        for (let i = 0; i < count; i++) {
            if (fixed[i]) {
                probability[i] /= fixedSum;
            }
        }
        fixedSum = 1;
    }

    const share = fixedCount < count ? (1 - fixedSum) / (count - fixedCount) : 0;
    for (let i = 0; i < count; i++) {
        if (!fixed[i]) {
            probability[i] = share;
        }
    }
    return probability;
}

function pickIndex(probability: number[]): number {
    const roll = Math.random();
    let cursor = 0;
    for (let i = 0; i < probability.length; i++) {
        cursor += probability[i];
        if (roll < cursor) {
            return i;
        }
    }
    return probability.length - 1;
}

function randomIndex(count: number): number {
    return Math.floor(Math.random() * count);
}

function clamp01(value: number): number {
    return Math.max(0, Math.min(1, value));
}
