// Compat shim (stronghold-ui package) — install ONLY when the target has no public/js/ui/namecards.js.
// 名片 (an account's name-card background) is a feature of the original deployment (accounts service + its card art).
// Without it a seat card shows no name-card layer.
export function NameCardLayer() { return null; }
