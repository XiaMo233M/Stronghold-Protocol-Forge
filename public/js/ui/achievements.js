// Compat shim (stronghold-ui package) — install ONLY when the target has no public/js/ui/achievements.js.
// 成就 / 同盟成就奖杯 is a feature of the original deployment (records kept by an accounts service). Without it the hub
// shows no 成就 entry.
export function AchievementEntry() { return null; }
export function AchievementPanel() { return null; }
