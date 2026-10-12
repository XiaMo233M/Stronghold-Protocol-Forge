// data/rules.mjs — 促融共竞的规则覆盖块（由 v1 modes.json 提取；官方模式字段不复制）。
// audit P1：官方 mode_multi_* 的回合表/敌人倍率/商店一律由引擎的官方记录提供，这里只放 MOD 自己的两个块；
// transferDesc 由同一份数字生成（audit P2：展示文案与配置不再各写一份）。
// 注意：coverInterest.enabled 保持 true（v1 原值）——它同时是「下回合还本金」那条账本的开关（economy.mjs），
// 关掉它会静默取消还款；包化第一版用 _econCoverTotal 的 shim 让兜底**分红**的利率恒为 0（见 README PENDING）。
export const XIE_RULES = Object.freeze({
  "FUNNY": {
    "modeId": "mode_xie_funny",
    "name": "协同共竞·标准",
    "teamEconomy": {
      "enabled": true,
      "transfer": {
        "maxPerRequest": 1,
        "requestsPerRound": 4,
        "teamCapPerRound": 8,
        "ttlSec": 30,
        "repayInterest": 0
      },
      "reserve": {
        "convertPerPlayerMax": 2,
        "perfectReward": 2,
        "perfectRewardCapPerRound": 2
      },
      "relief": {
        "enabled": true,
        "amount": 1,
        "lpThreshold": 10,
        "perPlayerPerRound": 2,
        "teamPerRound": 4
      },
      "projects": {
        "storehouse": {
          "costs": [
            4,
            8,
            12,
            16
          ]
        },
        "logistics": {
          "costs": [
            4,
            8,
            12,
            16
          ],
          "teamCapBonus": [
            4,
            8,
            12,
            16
          ]
        }
      },
      "deathDividend": {
        "enabled": true,
        "dice": 6
      },
      "coverInterest": {
        "enabled": true,
        "capPct": 100,
        "lagPremium": 2
      },
      "botLend": {
        "enabled": true,
        "basePct": 75,
        "weakPct": 20,
        "solventPct": 10,
        "coverPct": 10,
        "maxPct": 50,
        "tightFactorPct": 50,
        "delayMsMin": 600,
        "delayMsMax": 2200
      },
      "botAsk": {
        "enabled": true,
        "basePct": 8,
        "brokePct": 40,
        "keyPct": 60,
        "maxPct": 50,
        "keyMaxPct": 80
      }
    },
    "revival": {
      "enabled": true,
      "costPer": 5,
      "step": 5
    },
    "transferDesc": "单次最多借调 1 资金，每人每回合最多 4 次，全队每回合总额上限 8（ttl 30s）"
  },
  "NORMAL": {
    "modeId": "mode_xie_normal",
    "name": "协同共竞·险境",
    "teamEconomy": {
      "enabled": true,
      "transfer": {
        "maxPerRequest": 1,
        "requestsPerRound": 4,
        "teamCapPerRound": 8,
        "ttlSec": 30,
        "repayInterest": 0
      },
      "reserve": {
        "convertPerPlayerMax": 2,
        "perfectReward": 2,
        "perfectRewardCapPerRound": 2
      },
      "relief": {
        "enabled": true,
        "amount": 1,
        "lpThreshold": 10,
        "perPlayerPerRound": 2,
        "teamPerRound": 4
      },
      "projects": {
        "storehouse": {
          "costs": [
            4,
            8,
            12,
            16
          ]
        },
        "logistics": {
          "costs": [
            4,
            8,
            12,
            16
          ],
          "teamCapBonus": [
            4,
            8,
            12,
            16
          ]
        }
      },
      "deathDividend": {
        "enabled": true,
        "dice": 6
      },
      "coverInterest": {
        "enabled": true,
        "capPct": 100,
        "lagPremium": 2
      },
      "botLend": {
        "enabled": true,
        "basePct": 75,
        "weakPct": 20,
        "solventPct": 10,
        "coverPct": 10,
        "maxPct": 50,
        "tightFactorPct": 50,
        "delayMsMin": 600,
        "delayMsMax": 2200
      },
      "botAsk": {
        "enabled": true,
        "basePct": 8,
        "brokePct": 40,
        "keyPct": 60,
        "maxPct": 50,
        "keyMaxPct": 80
      }
    },
    "revival": {
      "enabled": true,
      "costPer": 5,
      "step": 5
    },
    "transferDesc": "单次最多借调 1 资金，每人每回合最多 4 次，全队每回合总额上限 8（ttl 30s）"
  },
  "HARD": {
    "modeId": "mode_xie_hard",
    "name": "协同共竞·绝境",
    "teamEconomy": {
      "enabled": true,
      "transfer": {
        "maxPerRequest": 1,
        "requestsPerRound": 4,
        "teamCapPerRound": 8,
        "ttlSec": 30,
        "repayInterest": 0
      },
      "reserve": {
        "convertPerPlayerMax": 2,
        "perfectReward": 2,
        "perfectRewardCapPerRound": 2
      },
      "relief": {
        "enabled": true,
        "amount": 1,
        "lpThreshold": 10,
        "perPlayerPerRound": 2,
        "teamPerRound": 4
      },
      "projects": {
        "storehouse": {
          "costs": [
            4,
            8,
            12,
            16
          ]
        },
        "logistics": {
          "costs": [
            4,
            8,
            12,
            16
          ],
          "teamCapBonus": [
            4,
            8,
            12,
            16
          ]
        }
      },
      "deathDividend": {
        "enabled": true,
        "dice": 6
      },
      "coverInterest": {
        "enabled": true,
        "capPct": 100,
        "lagPremium": 2
      },
      "botLend": {
        "enabled": true,
        "basePct": 75,
        "weakPct": 20,
        "solventPct": 10,
        "coverPct": 10,
        "maxPct": 50,
        "tightFactorPct": 50,
        "delayMsMin": 600,
        "delayMsMax": 2200
      },
      "botAsk": {
        "enabled": true,
        "basePct": 8,
        "brokePct": 40,
        "keyPct": 60,
        "maxPct": 50,
        "keyMaxPct": 80
      }
    },
    "revival": {
      "enabled": true,
      "costPer": 5,
      "step": 5
    },
    "transferDesc": "单次最多借调 1 资金，每人每回合最多 4 次，全队每回合总额上限 8（ttl 30s）"
  },
  "ABYSS": {
    "modeId": "mode_xie_abyss",
    "name": "协同共竞·终极",
    "teamEconomy": {
      "enabled": true,
      "transfer": {
        "maxPerRequest": 1,
        "requestsPerRound": 4,
        "teamCapPerRound": 8,
        "ttlSec": 30,
        "repayInterest": 0
      },
      "reserve": {
        "convertPerPlayerMax": 2,
        "perfectReward": 2,
        "perfectRewardCapPerRound": 2
      },
      "relief": {
        "enabled": true,
        "amount": 1,
        "lpThreshold": 10,
        "perPlayerPerRound": 2,
        "teamPerRound": 4
      },
      "projects": {
        "storehouse": {
          "costs": [
            4,
            8,
            12,
            16
          ]
        },
        "logistics": {
          "costs": [
            4,
            8,
            12,
            16
          ],
          "teamCapBonus": [
            4,
            8,
            12,
            16
          ]
        }
      },
      "deathDividend": {
        "enabled": true,
        "dice": 6
      },
      "coverInterest": {
        "enabled": true,
        "capPct": 100,
        "lagPremium": 2
      },
      "botLend": {
        "enabled": true,
        "basePct": 75,
        "weakPct": 20,
        "solventPct": 10,
        "coverPct": 10,
        "maxPct": 50,
        "tightFactorPct": 50,
        "delayMsMin": 600,
        "delayMsMax": 2200
      },
      "botAsk": {
        "enabled": true,
        "basePct": 8,
        "brokePct": 40,
        "keyPct": 60,
        "maxPct": 50,
        "keyMaxPct": 80
      }
    },
    "revival": {
      "enabled": true,
      "costPer": 5,
      "step": 5
    },
    "transferDesc": "单次最多借调 1 资金，每人每回合最多 4 次，全队每回合总额上限 8（ttl 30s）"
  }
});
