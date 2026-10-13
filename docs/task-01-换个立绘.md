# 换个立绘

- **你要做的事**：把一名官方干员的立绘，换成你自己画的一张图。
- **需要什么**：一张 PNG；一个能玩的整合包；5 分钟。不用写代码，不用懂 JSON。
- **花多久**：第一次 5 分钟，做过一次之后 2 分钟。

> 第一次做包的话，先看 [`START-HERE.md`](START-HERE.md) —— 那里有完整的四步。这篇只讲「换立绘」本身。

---

## 一、先把画好的图放好

1. 在整合包根目录下找到 `app\workshop\`，在里面建一个文件夹，名字用英文，例如 `my-portrait-pack`。
2. 在这个文件夹里新建一个文本文件，文件名 `pack.json`（注意扩展名是 `.json`，不是 `.txt`）。
3. 在 `pack.json` 旁边新建一个文件夹，名字 **全小写**：`assets`。
4. 把你画的那张图改名成 `portrait.png`，放进 `assets` 里。

做完长这样：

```
my-portrait-pack/
├── pack.json
└── assets/
    └── portrait.png
```

> 文件夹名 `my-portrait-pack` 后面要跟 `pack.json` 里的 `"id"` 写成同一个词。

---

## 二、查你要换的那名干员的 id

1. 在整合包根目录（有 `data\` 和 `tools\` 的那一层）打开命令提示符。
2. 粘贴这一行，回车：

```
node -e "const a=require('./data/assets.json');for(const k of Object.keys(a.chars))console.log(k, (a.chars[k].portrait||''))"
```

3. 屏幕上会打印 210 行，每行是「干员 id + 她现在的立绘路径」，例如：

```
char_003_kalts /assets/char/portrait/char_003_kalts_1.png
```

4. 找到你要换的那一行，把**左边那一串**（`char_003_kalts` 这样的）抄下来。

> `char_` 后面那串是官方编号，不是名字，猜不出来，只能查表。找不到想要的名字时，去游戏里看一眼她的称号，榜单上对得上。

---

## 三、把 `pack.json` 写成这样

把 `char_003_kalts` 换成你刚抄下来的那个 id，`"id"` 换成你的文件夹名：

```json
{
  "id": "my-portrait-pack",
  "name": "我给凯尔希画的立绘",
  "version": "1.0.0",
  "author": "你的名字",
  "license": "CC-BY-4.0",
  "description": "把凯尔希的立绘换成我自己画的一张图。",
  "api": ">=1 <2",
  "art": {
    "chars": {
      "char_003_kalts": {
        "portrait": "portrait.png"
      }
    }
  }
}
```

> `//` 开头的内容一个字都不要加 —— JSON 不允许注释，加了就打不开。

---

## 四、想连头像一起换，就多写三行

在 `"portrait"` 那一行下面接着写：

```json
        "avatar": "face.png",
        "portraitE2": "big-e2.png",
        "avatarE2": "face-e2.png"
```

`avatar` 是头像（手牌、名单里的小方图），`portraitE2` 和 `avatarE2` 是精锐化之后用的那两张。
**只写 `portrait` 时，另外三张还是官方的** —— 这是加法，不会把官方的图弄丢。
对应的三个图也要放进 `assets\`，文件名跟这里写的一致（大小写也要一致）。

---

## 五、验一遍

1. 在整合包根目录粘贴：

```
node tools/workshop-validate.mjs app/workshop
```

2. 看到下面两行就是对了：

```
0 error(s), 0 warning(s)
VALID: the engine accepts this content.
```

3. 关掉游戏窗口，重新启动游戏，进游戏看她的立绘。

> 引擎**没有热重载**：不重启，改了也看不到变化。这一步不是可选的。

---

## 六、卡住了看这里

- 报 `ART_NEEDS_ASSETS` —— `assets` 这个文件夹的名字写错了，或者放到了包的上一层。必须**全小写**，并且和 `pack.json` 同级。
- 报 `ASSETS_NEED_LICENSE` —— `"license"` 那一行被删了。有 `assets` 文件夹就**必须**写它。
- 校验过了但游戏里还是老图 —— ① 没重启游戏；② 图的名字和 `"portrait"` 后面写的不一致（大小写也算）；③ 干员 id 抄错了一位，换到别人身上去了。
- 立绘是空白的 —— 文件名里有中文或空格。改成纯英文、不带空格的再试。

---

## 七、下一步

- **打包和上传**：见 [`START-HERE.md`](START-HERE.md) 第 3、4 步，步骤完全一样。导出用 `workshop-pack.mjs export`，**别手工右键压缩**。
- **想换的是战斗里那个会动的小人（模型）**：那是另一个字段，要 `.skel` + `.atlas` + `.png` 三个文件，写错了游戏里不报错、只是画不出来。**第一次做包不要碰它**，先只换立绘和头像。
