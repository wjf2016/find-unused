const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const vscode = require('vscode');
const Queue = require('queue');
const scanDirSync = require('@wujianfu/scan-dir-sync');
const rgPath = path.join(path.dirname(__filename), './bin/rg.exe');

// 查找文件
function findFile() {
  if (vscode.workspace.workspaceFolders.length > 1) {
    vscode.window.showErrorMessage(
      'The extension only support one workspaceFolder for now.',
    );
    return;
  }

  vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: '',
      cancellable: false,
    },
    (progress, token) => {
      const basePath = vscode.workspace.workspaceFolders[0].uri.fsPath; // 扫描目录
      const unusedJson = path.join(basePath, 'unused.json');
      const message = '正在查找未使用的静态资源文件，请稍等...';
      let progressFlag = true;

      token.onCancellationRequested(() => {
        progressFlag = false;
      });

      progress.report({
        increment: 0,
        message,
      });

      return new Promise((resolve) => {
        const configuration = vscode.workspace.getConfiguration(); // 用户配置
        const ignore = configuration.get('findUnused.ignore'); // 扫描忽略规则
        const static = configuration.get('findUnused.static'); // 静态资源文件类型
        const staticIn = configuration.get('findUnused.staticIn'); // 引用静态资源的文件类型
        const staticArr = []; // 静态资源文件列表
        const staticInArr = []; // 引用静态资源的文件列表

        // 开始扫描
        const result = scanDirSync(basePath, {
          ignore,
          include: static.concat(staticIn),
        });

        progress.report({
          increment: 33,
        });

        // 静态资源和非静态资源归类
        result.forEach((item) => {
          const extName = path.extname(item);

          // 是否在静态资源列表中
          const inStatic = static.some((item) => {
            return item.toLowerCase() === extName.toLowerCase();
          });

          // 是否在引用静态资源的文件列表中
          const inStaticIn = staticIn.some((item) => {
            return item.toLowerCase() === extName.toLowerCase();
          });

          if (inStatic) {
            staticArr.push(item);
          }

          if (inStaticIn) {
            staticInArr.push(item);
          }
        });

        progress.report({
          increment: 33,
        });

        const totalCount = staticArr.length;
        let currentCount = 0;
        let lastPercent = 0;
        const unusedArr = []; // 未使用的静态资源文件列表

        if (os.type() === 'Windows_NT') {
          const rgResult = [];
          // Windows系统下使用rg命令快速全文搜索
          const queue = Queue({
            concurrency: 2,
            results: rgResult,
          });

          staticArr.forEach((staticFile) => {
            const fileName = path.basename(staticFile);
            const ignoreStr = ignore.reduce((prev, next) => {
              return `${prev}-g "!${next}" `;
            }, '');
            const staticInStr = staticIn.reduce((prev, next) => {
              return `${prev}-g "*${next}" `;
            }, '');

            const args = `"${fileName}" "${basePath}" -i --hidden --count-matches --no-filename ${ignoreStr} ${staticInStr}`;
            const argsArr = args.split(' ');

            queue.push(function () {
              return new Promise((resolve, reject) => {
                spawnPromise(`"${rgPath}"`, argsArr, {
                  shell: true,
                })
                  .then((res) => {
                    const { stdout, stderr, code } = res;

                    if (code === 1 && !stdout && !stderr) {
                      // 全文搜索未找到fileName（即文件未被引用时）
                      unusedArr.push({
                        path: staticFile,
                        size: fs.statSync(staticFile).size,
                      });
                    }

                    resolve(res);
                  })
                  .catch((err) => {
                    reject(err);
                  })
                  .finally(() => {
                    currentCount++;
                  });
              });
            });
          });

          // 报告进度
          const interval = setInterval(() => {
            const percent = parseInt((currentCount / totalCount) * 100);

            progress.report({
              increment: percent - lastPercent,
            });

            lastPercent = percent;
          }, 500);

          queue.start(function (err) {
            // 有错误发生时
            if (err) {
              console.error(err);
              return;
            }

            clearInterval(interval);

            console.log(unusedArr);

            const totalSize = formatSize(
              unusedArr.reduce((prev, next) => {
                return prev + next.size;
              }, 0),
            );

            unusedArr.sort((a, b) => {
              return b.size - a.size;
            });

            unusedArr.forEach((item) => {
              item.size = formatSize(item.size);
            });

            // 写入文件
            fs.writeFileSync(unusedJson, JSON.stringify(unusedArr, null, 2));

            vscode.window.showInformationMessage(
              `找到未使用的静态资源文件共${unusedArr.length}个，总体积为：${totalSize}`,
            );

            // 打开文件
            vscode.workspace
              .openTextDocument(vscode.Uri.file(unusedJson))
              .then((doc) => vscode.window.showTextDocument(doc));

            resolve();
          });

          return;
        }

        // 由于查找时间较长，这里使用异步方法执行，避免ui卡死
        setTimeout(() => {
          for (let staticFile of staticArr) {
            if (!progressFlag) {
              return;
            }

            let unused = true;

            for (let staticInFile of staticInArr) {
              if (!progressFlag) {
                return;
              }

              const fileContent = fs.readFileSync(staticInFile, 'utf8');

              if (fileContent.includes(path.basename(staticFile))) {
                unused = false;
                break;
              }
            }

            if (unused) {
              unusedArr.push({
                path: staticFile,
                size: fs.statSync(staticFile).size,
              });
            }
          }

          const totalSize = formatSize(
            unusedArr.reduce((prev, next) => {
              return prev + next.size;
            }, 0),
          );

          unusedArr.sort((a, b) => {
            return b.size - a.size;
          });

          unusedArr.forEach((item) => {
            item.size = formatSize(item.size);
          });

          progress.report({
            increment: 34,
          });

          // 写入文件
          fs.writeFileSync(unusedJson, JSON.stringify(unusedArr, null, 2));

          vscode.window.showInformationMessage(
            `找到未使用的静态资源文件共${unusedArr.length}个，总体积为：${totalSize}`,
          );

          // 打开文件
          vscode.workspace
            .openTextDocument(vscode.Uri.file(unusedJson))
            .then((doc) => vscode.window.showTextDocument(doc));

          resolve();
        }, 500);
      });
    },
  );
}

// 删除文件
function deleteFile() {
  if (vscode.workspace.workspaceFolders.length > 1) {
    vscode.window.showErrorMessage(
      'The extension only support one workspaceFolder for now.',
    );
    return;
  }

  const basePath = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const unusedJson = path.join(basePath, 'unused.json');

  if (!fs.pathExistsSync(unusedJson)) {
    vscode.window.showErrorMessage('There is no file named unused.json!');
    return;
  }

  vscode.window
    .showInputBox({
      prompt:
        "Find Unused: Please enter 'yes' to delete file list in unused.json. (Please make a backup before you do this.)",
    })
    .then(function (answer) {
      if (answer === 'yes') {
        const fileContentArr = JSON.parse(fs.readFileSync(unusedJson, 'utf-8'));

        fileContentArr.forEach((file) => {
          if (fs.pathExistsSync(file.path)) {
            fs.removeSync(file.path);
          }
        });

        fs.removeSync(unusedJson);
        vscode.window.showInformationMessage(
          'Deleted all files in unused.json.',
        );
      }
    });
}

// 格式化大小
function formatSize(size) {
  const maxMb = 1024 * 1024 * 1024;
  const maxKb = 1024 * 1024;

  size = parseInt(size);

  // 大于等于1024Mb时
  if (size >= maxMb) {
    return `${(size / maxMb).toFixed(2)}G`;
  }

  // 大于等于1024Kb时
  if (size >= maxKb) {
    return `${(size / maxKb).toFixed(2)}M`;
  }

  // 大于等于1024b时
  if (size >= 1024) {
    return `${(size / 1024).toFixed(2)}Kb`;
  }

  return `${size}b`;
}

// 执行子进程命令
function spawnPromise(command, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';

    const commandSpawn = spawn(
      command,
      args,
      Object.assign(
        {
          shell: true, // If true, runs command inside of a shell. Uses '/bin/sh' on Unix, and process.env.ComSpec on Windows. A different shell can be specified as a string. See Shell Requirements and Default Windows Shell. Default: false (no shell)
        },
        options,
      ),
    );

    commandSpawn.stdout.on('data', (data) => {
      stdout = `${stdout}${data}`;
    });

    commandSpawn.stderr.on('data', (data) => {
      stderr = `${stderr}${data}`;
    });

    commandSpawn.on('close', (code) => {
      resolve({
        stdout,
        stderr,
        code,
      });
    });

    commandSpawn.on('error', (error) => {
      reject(error);
    });
  });
}

function activate() {
  console.log('find-unused is now active!');

  // 注册“查找未使用文件”命令
  vscode.commands.registerCommand('findUnused.find', findFile);

  // 注册“删除未使用文件”命令
  vscode.commands.registerCommand('findUnused.delete', deleteFile);
}

module.exports = {
  activate,
};
