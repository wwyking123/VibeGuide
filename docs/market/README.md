# 插件市场投稿

`wwyking123__VibeGuide.yml` 是提交给 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 的条目，原样放到对方仓库的 `data/plugins/` 下，一个 PR 只加这一个文件。收录要求见对方的 [contributing.md](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md)。

提交前要先做完：

1. GitHub 仓库加上 `dsh-plugin` 话题标签。
2. 建一个 GitHub Release，附上 `sh scripts/release.sh` 生成的 `artifacts/vibeguide-dsh-bundle.tgz`。条目里的 `tarball` 指向 `releases/latest/download/`，文件名不能带版本号，否则下次发版后链接失效。

描述会被维护者对着代码核对，改功能时记得同步改这里的描述。
