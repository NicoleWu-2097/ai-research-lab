import { render } from "ink";
import { App } from "./app.js";

const isTTY = Boolean(process.stdout.isTTY);

function enterFullscreenTui() {
  if (!isTTY) return;
  // ?1049h: 进入独立备用屏幕缓冲区（Alternate Screen Buffer），隔离外部终端历史
  // ?1000h + ?1006h: 启用 SGR 鼠标滚轮事件捕获，防止滚轮滚动外部终端
  // 2J + H: 清屏并将光标移至左上角
  process.stdout.write("\x1b[?1049h\x1b[?1000h\x1b[?1006h\x1b[2J\x1b[H");
}

let restored = false;
function restoreTerminal() {
  if (!isTTY || restored) return;
  restored = true;
  // 关闭 SGR 鼠标捕获并退回主屏幕缓冲区，完整恢复外部终端现场
  process.stdout.write("\x1b[?1006l\x1b[?1000l\x1b[?1049l");
}

enterFullscreenTui();
process.on("exit", restoreTerminal);
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    restoreTerminal();
    process.exit(0);
  });
}

const instance = render(<App />);
void instance.waitUntilExit().finally(() => {
  restoreTerminal();
});
