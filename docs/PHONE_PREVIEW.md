# 手机只读预览（Mac 关机也能看）

iCloud 可以把文件同步到 iPhone 的“文件”App，**不能**替代 RecordShelf 网站。
手机要看封面宫格、评分、专辑介绍、曲目和动态封面，仍然需要一个**只读网站**去渲染最后一次快照。

本机 `http://127.0.0.1:4173` 在 Mac 关机后不可用。Git / DMG / GitHub 也永远不会包含你的私人音乐库。

## 怎么工作

1. **Mac 开机时**：RecordShelf 或 `npm run remote-preview:sync` 把
   `shared-local-state.json`、本机目录、`/private-covers` 封面、动态 WebP
   打成一份快照。
2. 这份快照上传到 **Vercel Blob（私有）**，并可选复制到
   `~/Library/Mobile Documents/com~apple~CloudDocs/RecordShelf/preview/`
   作为 iCloud Drive 备份。
3. **手机 Safari** 打开受保护的 Vercel 网址。站点只读：没有添加唱片、
   改评分、保存介绍、刷新曲目或拉取动态封面。
4. **Mac 关机后**，手机仍看到**上一次成功快照**。过期可以，页头会显示更新时间。

## 你还需要完成的配置

代码已经就位，但云端密钥不会被提交进 Git。按顺序做一次即可。

### 1. 部署只读 SPA

在 `app/` 目录：

```bash
npx vercel login
npx vercel link --yes
npx vercel --prod
```

Vercel 项目 Root Directory 设为 `app`。公开构建仍然只带匿名示例；真正的音乐库只在快照里。

### 2. 私有对象存储 + 预览密码

1. 在 Vercel 项目里创建 [Blob](https://vercel.com/docs/vercel-blob) store，复制 `BLOB_READ_WRITE_TOKEN`。
2. 设置环境变量（Production / Preview / Development 都加上）：
   - `BLOB_READ_WRITE_TOKEN`
   - `RECORDSHELF_PREVIEW_PASSWORD`（你自己的门禁密码，不要用弱密码）
3. 打开 **Deployment Protection**（Vercel 密码或登录保护），避免被搜索引擎公开收录。

本机也可把 token / 密码写成（权限 `0600`，不要提交）：

```text
~/Library/Application Support/RecordShelf/blob-read-write-token
~/Library/Application Support/RecordShelf/preview-password
```

或放在被忽略的 `app/.env.local`：

```bash
BLOB_READ_WRITE_TOKEN=
RECORDSHELF_PREVIEW_PASSWORD=
```

### 3. 第一次上传快照

Mac 开机、私人目录存在时：

```bash
cd app
npm run remote-preview:sync
```

或在本地 RecordShelf「设置 → 同步到手机预览」。没有 Blob token 时，脚本仍会打好本机快照并尽量复制到 iCloud Drive，但**网站上还是看不到**。

## iCloud 能做什么 / 不能做什么

- **能**：备份快照文件夹；换一台 Mac 时把文件拷回来。
- **不能**：在 iPhone 上打开 RecordShelf 界面。Files App 里那些 JSON / WebP
  只是文件，没有曲目、评分和动态封面的浏览页。不要为此去做 CloudKit 应用。

## 隐私

- 快照和封面**不许** git-add。
- 远程接口只实现 GET。上传只发生在本机 Mac。
- OAuth 客户端记录、API Key、Apple Music token 不会打进快照。
