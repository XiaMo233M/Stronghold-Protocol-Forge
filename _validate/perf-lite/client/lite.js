// perf-lite 的面板模块：这个包的效果全在样式表与主题变量里，面板本身不画任何东西。
// 面板是 `styles[]` 的挂载点（样式表随面板注入），所以必须存在一个合法模块；`mount` 返回空对象即可。
export function mount() {
  return {};
}
