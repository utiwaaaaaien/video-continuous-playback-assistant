# 视频连续播放助手 V2.1 · Mac 本地唤醒组件

这个组件由 Chrome Native Messaging 启动，仅接收“保持唤醒/释放唤醒”指令。它使用系统 IOKit 电源断言和活动声明，帮助防止播放期间因闲置进入屏保或锁屏。不会移动鼠标、发送按键或修改系统设置；没有任意命令执行、网络访问、读取课程内容或账号的功能。

组件包含 Apple Silicon / Intel 双架构可执行文件及完整 Objective-C 源代码。扩展端需要 nativeMessaging 权限，注册文件只允许安装时指定的一个扩展 ID 连接。

## 安装

双击“安装Mac唤醒组件.command”，粘贴 chrome://extensions 中“视频连续播放助手”的扩展 ID。脚本将可执行文件复制到当前用户的 Library/Application Support/Video Continuous Playback Assistant/VideoWakeHost，并向 Library/Application Support/Google/Chrome/NativeMessagingHosts 写入 org.codex.video_continuous_playback.json。Chrome 从 Application Support 启动组件，运行期间不需要文稿目录权限。无需管理员权限、后台启动项或辅助功能授权。扩展 ID 改变后重新运行安装脚本。安装完成后不依赖发布包所在目录。

组件在 Chrome 与扩展开启保护期间运行。暂停/停止时释放，浏览器关闭、连接断开或进程退出时释放；没有后续指令时最迟 90 秒释放，并有系统断言超时作为后备。扩展实际使用 75 秒租期并定期续期。组件检测系统已锁定或切出当前用户时释放，不自动解锁；手动锁屏和合盖仍由系统处理。

活动声明会在播放期间推迟系统的闲置计时。停止播放后恢复正常计时，系统锁屏仍按原有设置运行。面板只有收到组件确认后才显示“Mac 本地保护”。不能覆盖企业强制锁屏策略或证明所有 macOS 版本都无故障。

## 移除

先停用扩展中的保持唤醒，再删除上述 org.codex.video_continuous_playback.json 注册文件。之后删除 Library/Application Support/Video Continuous Playback Assistant 文件夹；无需修改任何系统锁屏设置。

## 源码编译

使用 Apple Command Line Tools：

```sh
xcrun clang -fobjc-arc -O2 -arch arm64 -arch x86_64 -mmacosx-version-min=11.0 -framework Foundation -framework IOKit -framework ApplicationServices VideoWakeHost.m -o VideoWakeHost
```

依据：[Chrome Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)、[Apple IOPMAssertionDeclareUserActivity](https://developer.apple.com/documentation/iokit/1557179-iopmassertiondeclareuseractivity)。
