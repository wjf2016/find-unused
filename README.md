# 扩展介绍

查找并删除未使用的静态资源文件，按`F1`或`ctrl+shift+p`执行命令`findUnused find`，扩展将根据用户配置自动查找项目中未使用的静态资源文件，并将结果保存在`unused.json`中。该文件位于项目根目录下，请仔细检查该文件内容。你可以按照相关格式添加遗漏文件或删除不正确的文件路径。如果你想删除该列表中的所有文件，请执行命令`findUnused delete`，按照提示输入`yes`后将 `unused.json`列表中的文件删除。（请谨慎使用，建议删除前备份）

# 扩展配置

请在设置中搜索“findUnused”，找到扩展设置，并按照说明进行配置。

# Changelog

## [0.0.8] - 2020-5-7

### Changed

- 优化算法，不再卡 ui
