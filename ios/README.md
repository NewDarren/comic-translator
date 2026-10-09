# iPhone / iPad 原站漫画浏览器

这是 **iOS 源码原型**，不是已编译或真机验证的 App。它用 `WKWebView` 打开输入的 HTTPS 漫画目录或章节网址，保留网站自己的目录、章节链接、返回与前进历史；当前屏幕的漫画图像稳定后自动尝试英译华文，不需要每页按「翻译」。翻译显示在独立覆盖层，原网站图片和链接不改动，关闭「中文」即可看原文。网站若限制内嵌浏览器、登录或弹出验证，仍可能无法阅读。

## 两种翻译方式

- **设备端 ML Kit（默认）**：本机截图 → Latin 英文 OCR → 英译中文 → 仅在可信的平整浅色对白区域遮住英文并排华文。无需 API Key，也没有按页计费的翻译请求。英文识别模型随 App 打包；英中翻译语言模型首次使用时需要下载，代码只允许通过 Wi-Fi 下载。模型下载完成后，识字和翻译在设备上运行；访问漫画网站仍需要网络。
- **云端图片模型（可选）**：沿用原有图片模型路线，能利用画面上下文判断对白框，但须在设置中填写自己的 API Key 和支持图片输入、Responses API strict JSON schema 的模型。截图会发送给服务商，按账户规则计费。设置里的 Key 只存本次 App 内存会话，重启后需重填；不要把共用 Key 编译进公开 App。

设备端模式只翻译英语漫画，OCR 的文字矩形**不是对白框边界**。为避免盖住画面，程序只覆盖确定程度较高的浅色、平整背景文字；复杂纹理、拟声词、压在人像上的字、裁切或读不清的对白可能保持英文。Google 将设备端翻译定位于简单、日常的翻译；人物口吻、双关和专有名词仍需对照原文校对，不能保证达到人工译稿质量。ML Kit 的语言代码 `zh` 只标记「中文」，没有单独的简体/繁体选项；代码会尽量把字形规范为简体，但用词和译名仍需真机检查。

## 在 Mac 上编译

需要 Mac、Xcode 15 或更新版本、XcodeGen、CocoaPods，以及 iOS / iPadOS 16 或更新的 64 位设备。当前开发环境是 Windows，没有 Xcode / iOS SDK；这里**尚未运行 `pod install`、iOS 编译或真机翻译测试**。

在本目录运行：

```sh
xcodegen generate
pod install
open ComicBrowser.xcworkspace
```

请打开 CocoaPods 生成的 **`.xcworkspace`**，不要只打开 `.xcodeproj`，否则 Swift 找不到 ML Kit。`Podfile` 固定使用 Google 官方文档中的 `GoogleMLKit/TextRecognition` 与 `GoogleMLKit/Translate` 8.0.0。每次改动 `project.yml` 后，先重新 `xcodegen generate`，再运行 `pod install`。在 Xcode 改成自己的 Bundle Identifier，选自己的签名 Team 和目标设备，Build / Run。

没有 Mac 时，可在私人 GitHub 仓库的 **Actions → Build unsigned iOS IPA → Run workflow** 手动触发 macOS 构建（公开仓库会跳过）。成功后，从该次运行的 **Artifacts** 下载 `ComicBrowser-unsigned-ipa`；内含 `ComicBrowser-unsigned.ipa`。流程只编译 iPhone 的 arm64 App 并打包，**没有签名**，下载的 IPA 不能直接在 iPhone 打开。需用 AltStore/AltServer 等工具以自己的 Apple ID 签名并安装；这一步及真机翻译效果尚未验证。工作流程不会因推送源码自动运行，构建产物保留 3 天。

若不用 XcodeGen 而手动创建 SwiftUI iOS App，需把 `ComicBrowserApp.swift`、`TranslationService.swift`、`MLKitTranslationService.swift` 加入同一 target，把 `Overlay.js` 加到 **Copy Bundle Resources**，并令 Xcode target 名为 `ComicBrowser`（或同步修改 Podfile target 名）。移除模板自带的 `@main App`；部署目标设为 iOS 16，随后在工程目录 `pod install` 并打开 `.xcworkspace`。

## 阅读行为与限制

地址栏可直接打开目录或章节；站内翻页、返回目录、历史后退与前进继续使用原网站。原生侧在画面稳定、可见漫画大图加载后才自动翻译当前屏幕；滚动、翻页和换章会清掉旧覆盖并尝试新画面。目录、缩略图和导航图应被跳过，但这些判断仍是启发式，需要在目标漫画站实测。会话内缓存避免同一画面重复翻译；目前没有整章预译、后台下载、跨重启保存译稿或完整人工校对编辑器。

覆盖层仅处理浅色、平整背景；如果译文无法安全排入，保留原文。遮罩和译文不会取代原图像素；覆盖层不截断网站链接点击。横竖屏、缩放、动态换图、内部滚动容器或 Canvas 阅读器可能使定位不准，仍需真机检查。自动翻译发生错误时不会无限重试；可检查网络或设置后手动重新翻译当前画面。

设备端路线不会把截图送到翻译 API，但网站本身照常通过 WebKit 加载内容，首次 ML Kit 语言模型下载也需要连接 Google。若选择云端模式，当前可见网页截图（可能包含广告或个人资料）会发送到所配置服务商。云端请求设置 `store: false`、不自动重试，并禁止 HTTP 重定向；这不是对服务商所有数据处理的保证。

## Google 标示与发布

Google 要求使用 ML Kit 设备端翻译的应用遵守适用的 [Cloud Translation 归属标示规则](https://developers.google.com/ml-kit/language/translation/translation-terms)。发布前应检查 App 内译文附近的 Google Translate 标示、App 说明及帮助页，并复核当时有效的[具体归属要求](https://docs.cloud.google.com/translate/attribution)。不要让产品名称暗示 Google 官方关联。GitHub 仓库能分享源码，不能单靠仓库链接让 iPhone 用户直接运行；分发仍需按 Apple 的安装、测试或上架流程进行。

## 真机验收

1. 打开 MangaDex 英文目录，进一章、返回目录、再选另一章；确认原站导航和链接可用。
2. 首次在 Wi-Fi 下等待模型下载；完成后断开网络，用已加载画面验证本机 OCR/翻译。检查无 API Key 时设备端仍能运行，云端模式则明确要求 Key。
3. 检查自动翻译、连续滚动、快速跳页、换章和返回；旧画面译文不应盖到新页，会话缓存不应反复请求。
4. 抽查漏字、人物名、语气、简繁字形、长对白排版和复杂背景；无法安全覆盖的区域应保留原文。
5. 切换「中文」确认原图恢复；横竖屏、网页缩放和动态换页后确认覆盖位置。
6. 检查无 Wi-Fi、模型下载失败、网站登录或阻挡，以及云端 Key 错误、限额、网络中断的提示和恢复流程。

实现依据：[ML Kit SDK 与费用说明](https://developers.google.com/ml-kit/guides)、[iOS 英文文字识别](https://developers.google.com/ml-kit/vision/text-recognition/v2/ios)、[设备端英译中文](https://developers.google.com/ml-kit/language/translation/ios)、[翻译适用范围](https://developers.google.com/ml-kit/language/translation)、[Apple WKWebView 截图](https://developer.apple.com/documentation/webkit/wkwebview/takesnapshot(with:completionhandler:))。
