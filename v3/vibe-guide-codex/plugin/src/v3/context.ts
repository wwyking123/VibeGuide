/** Keep model input valid JSON with an explicit truncation marker and bounded total text. */
export function boundedContext(value: unknown, limit = 42000): {
    value: unknown;
    truncated: boolean;
} {
    let remaining = limit, truncated = false;
    function visit(v: unknown): unknown {
        if (typeof v === 'string') {
            const allowed = Math.min(remaining, 12000);
            remaining -= Math.min(allowed, v.length);
            if (v.length > allowed) {
                truncated = true;
                return v.slice(0, allowed) + '\n[材料截断，不能据此断言完整结果]';
            }
            return v;
        }
        if (Array.isArray(v)) {
            const selected = [];
            for (const item of [...v].reverse()) {
                if (remaining < 300) {
                    truncated = true;
                    break;
                }
                selected.push(visit(item));
            }
            return selected.reverse();
        }
        if (v && typeof v === 'object') {
            const out: Record<string, unknown> = {};
            for (const [k, item] of Object.entries(v)) {
                if (remaining < 100) {
                    truncated = true;
                    break;
                }
                out[k] = visit(item);
            }
            return out;
        }
        return v;
    }
    return { value: visit(value), get truncated() { return truncated; } };
}
