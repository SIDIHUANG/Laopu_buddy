普瑞塞斯桌宠 · v2（exe 启动版）  ——  怎么用 / 怎么看日志 / 出问题怎么办
========================================================================

一、启动
    双击  presage-pet.exe      ← 就这样，没有第二步。

    不要用「以管理员身份运行」：
      提权会导致 (a) 托盘图标注册被系统拒绝
                (b) 透明窗口的 GPU 合成失效（她就画不出来了）
      exe 启动时会把「提权=是/否」写进日志，不用猜。

    exe 自己会做这些事（v1.1 是由 启动桌宠.bat 做的）：
      * 把日志/profile/桥接输出都放在 exe 旁边的 runtime\
      * 检查 WebView2Loader.dll 与 WebView2 运行时；缺哪个直接弹框告诉你
      * 检查是不是已经有她在跑（有的话只弹一句提示，不会起第二个）
      * 隐藏启动桥接（tools\pet_bridge.mjs），**没有黑窗口**
      * 退出时把桥接一起收掉，不留后台 node

    「启动桌宠.bat」只是可选入口（给必须走 bat 的场景），里面没有任何逻辑。

二、托盘 & 退路
    这台机器上图标可能不会出现在通知区（系统拒绝注册，与 v1 相同，
    属环境级限制，详见 OPEN-ISSUES.md）。所以入口有两个：
      * 右键点她 → 设置 / 退出
      * 全局热键  Ctrl+Alt+S（设置）   Ctrl+Alt+Q（退出）

三、日志（都在 exe 旁边的 runtime\ 里）
    runtime\pet.out.log        桌宠自己的日志（原生 + 前端）
    runtime\pet.err.log        stderr（应为空或不生成）
    runtime\bridge.log         桥接日志（每次启动前会清空）
    runtime\bridge.err.log     桥接的报错
    runtime\diag.txt           --diag 生成的诊断报告
    %LOCALAPPDATA%\PresagePet\pet.log   总是可写的那一份兜底日志

四、出问题了？
    1) 最省事的一步：双击  诊断-导出报告.bat
       （等价于 presage-pet.exe --diag）
       它会写 runtime\diag.txt 并用记事本打开 —— 把整份内容发出去就行。
       报告里这几行最关键：
         WebView2Loader.dll : 在 exe 旁边 ✓ / 缺失 ✗
         WebView2 运行时    : 已安装 ✓ / 未检测到 ✗
         提权               : 提权=否
         [geom:boot] … 裁掉=0px 出屏=0px     ← 非 0 就是确定的几何故障
         GET /health        : {"ok":true,…}  ← 没有响应说明桥接没起来

    2) 她闪一下就没 / 完全不见：
       * 先看 runtime\pet.err.log（非空就是崩了，里面有原因）
       * 再看 runtime\pet.out.log 里 [boot] / [bridge] / [geom: 开头的行
       * profile 坏了不用你管：exe 下次启动会自己删掉重建
         （看到 [boot] 发现上次的启动失败标记 → 已先删除 WebView2 profile 重建
           就是它自己在修）

    3) 缺 WebView2Loader.dll 的症状：双击**毫无反应**（0xC0000135，连对话框都没有）。
       它必须和 exe 放在同一个目录。

    4) 缺 WebView2 运行时的症状：exe 会弹一个框告诉你，并给官方下载地址。

五、关于 node（桥接）
    桥接需要 node.exe。exe 按这个顺序找：
      1. 环境变量 PRESAGE_NODE    —— 想指定某个 node 时用它；
                                     设成 none / off / 0 表示「我不要桥接」，回退链整段跳过
      2. PATH 上的 node.exe
      3. DSH 自带的那份（%USERPROFILE%\.dsh\…\node.exe）
      4. Program Files\nodejs 等常见安装位置
    都找不到也不会启动失败 —— 桌宠本体照跑，只是没有 live 事件与余额播报，
    日志里会写一行「没找到 node.exe … 跳过桥接」。
    （PRESAGE_NODE 指向一个**不存在的文件**时不会关掉桥接，只会记一行日志然后
      继续按 2~4 找 —— 手滑写错路径不该让桥接整个消失。）

六、已知限制（与 v1.1 相同，本版没动）
    * 托盘图标可能被系统拒绝注册 → 用右键菜单或 Ctrl+Alt+S / Ctrl+Alt+Q
    * 抠图残留（手臂与身体之间的浅灰缝）→ 需要从源素材解决
    * 窗口仍会出现在任务栏
    * celebrate 用的是难过脸弹跳（缺一张笑脸立绘）
    详见 OPEN-ISSUES.md。

七、这一版到底改了什么 / 怎么重建
    见 V2-BASELINE.md。
    重建两条命令：
      $env:PYTHONIOENCODING = "utf-8"; python tools\build_web_v2.py
      cd v2\app\src-tauri; cargo build --release
    装配 + 自检 + 验收：
      powershell -NoProfile -ExecutionPolicy Bypass -File tools\pack_v2.ps1
      powershell -NoProfile -ExecutionPolicy Bypass -File tools\test_v2_exe.ps1
