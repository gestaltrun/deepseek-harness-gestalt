# 归档说明 · IM 接管设计（用户已认可）

- 归档时间：2026-09-06（本会话末轮）；来源：workspace `.design/`（已按用户指示在归档验证后删除）；更早迭代稿保留在 /tmp/dsh-im-takeover-kimi-design/（未动）。
- 用户本轮明确表示：当前设计稿已认可，转技术分析；上游合并未完成。本归档不升级任何权限或产品假设。
- 已确认语义详见 README.md / manifest.json。**仍未确认**（不得视为已拍板）：群聊触发的 OR 任一满足、交叠一次处理的去重行为、N 条计数窗口/重置、定时周期边界与时区、demo 初值（@勾选、N=10、5 分钟）。
- 保真声明边界：壳（导航/设置壳/工作区弹层壳/Sidebar/图标轨）为有据重建，不宣称逐像素一致；千牛「连接后回显商家身份」为拟议能力（无 whoami 接口证据）。
- 复跑方式：cd 本目录 && npm install && npm run dev（http://127.0.0.1:5174/）；正式组件 file: 引用 /Applications/DeepSeek Gestalt.app 的 checkout，若该应用更新需按 manifest.json 的 updatePolicy 重抓快照。
