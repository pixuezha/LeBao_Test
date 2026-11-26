const { ccclass } = cc._decorator;

// Q2 上腔收口位于金币父节点坐标 (9, 10) 附近；范围不延伸到针区。
function atNeck(node: cc.Node): boolean {
    return node.y >= 0 && node.y <= 42 && Math.abs(node.x - 9) <= 30;
}

function isSlideSurface(node: cc.Node): boolean {
    return !!node && (node.name === "walls" || node.name === "bottle");
}

/**
 * 单独成脚本：Cocos 2.4 一个文件只能有一个 Component。
 * 凹多边形拆凸块后，拼缝会卡住圆。这里只在贴墙/贴瓶、几乎停住、又不是瓶底时，
 * 沿下坡方向轻轻拨一下。针不走这条路，金币仍停在针上。
 */
@ccclass("Q2Slide")
export default class Q2Slide extends cc.Component {
    private nudged = -1;

    onPreSolve(contact: cc.PhysicsContact, _self: cc.PhysicsCollider, other: cc.PhysicsCollider) {
        // 窄口内允许金币短暂错身，离开后立即恢复堆叠；绝不忽略针或墙。
        if (atNeck(this.node) && other.node.parent === this.node.parent
            && other instanceof cc.PhysicsCircleCollider && atNeck(other.node)) {
            contact.disabledOnce = true;
            return;
        }
        if (!isSlideSurface(other.node)) return;
        contact.setFriction(0);
        contact.setRestitution(0.04);
    }

    onPostSolve(contact: cc.PhysicsContact, _self: cc.PhysicsCollider, other: cc.PhysicsCollider) {
        if (!isSlideSurface(other.node)) return;
        const now = cc.director.getTotalTime();
        if (now - this.nudged < 40) return;
        const body = this.getComponent(cc.RigidBody);
        if (!body) return;
        const wm = contact.getWorldManifold();
        if (!wm || !wm.points || !wm.points.length || !wm.normal) return;
        const world = this.node.convertToWorldSpaceAR(cc.v2(0, 0));
        const cp = wm.points[0];
        let nx = wm.normal.x;
        let ny = wm.normal.y;
        if (nx * (world.x - cp.x) + ny * (world.y - cp.y) < 0) {
            nx = -nx;
            ny = -ny;
        }
        if (ny > 0.78) return;
        const v = body.linearVelocity;
        if (Math.sqrt(v.x * v.x + v.y * v.y) > 48) return;
        let tx = -ny;
        let ty = nx;
        if (ty > 0) {
            tx = -tx;
            ty = -ty;
        }
        this.nudged = now;
        body.linearVelocity = cc.v2(v.x + tx * 46, v.y + ty * 46);
    }
}
