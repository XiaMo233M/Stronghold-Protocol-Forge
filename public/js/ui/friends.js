// Compat shim (stronghold-ui package) — install ONLY when the target has no public/js/ui/friends.js.
// 好友 is a feature of the original deployment (an accounts service: friend list, presence, invitations). Without it:
// the hub shows no 好友 tile and the room shows no 邀请好友 button (room.js reads `openFriends.unavailable`).
export function FriendsTile() { return null; }
export function openFriends() {}
openFriends.unavailable = true;
