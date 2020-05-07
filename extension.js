const fs = require('fs-extra');
const fsPromises = require('fs').promises;
const path = require('path');
const os = require('os');
const { spawn, exec } = require('child_process');
const vscode = require('vscode');
const Queue = require('queue');
const scanDirSync = require('@wujianfu/scan-dir-sync');
const rgPath = path.join(path.dirname(__filename), './bin/rg.exe');

// 调试用，固定使用rg命令或者使用node查找
os.type = function () {
  return '';
};

// 查找文件
function findFile() {
  if (vscode.workspace.workspaceFolders.length > 1) {
    vscode.window.showErrorMessage(
      '此扩展只支持一个工作区目录，您的项目中含有多个工作区目录！',
    );
    return;
  }

  vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: '',
      cancellable: true,
    },
    (progress, token) => {
      const startTime = Date.now();
      const basePath = vscode.workspace.workspaceFolders[0].uri.fsPath; // 扫描目录
      const unusedJson = path.join(basePath, 'unused.json');
      const message = '正在查找未使用的静态资源文件，请稍候...';
      let progressFlag = true;
      let interval;

      token.onCancellationRequested(() => {
        clearInterval(interval);
        progressFlag = false;
      });

      progress.report({
        increment: 0,
        message,
      });

      return new Promise((resolve) => {
        const configuration = vscode.workspace.getConfiguration(); // 用户配置
        const ignore = configuration.get('findUnused.ignore'); // 忽略的文件或目录
        const static = configuration.get('findUnused.static'); // 静态资源文件类型
        const staticIn = configuration.get('findUnused.staticIn'); // 引用静态资源的文件类型
        const staticArr = []; // 静态资源文件列表
        const staticInArr = []; // 引用静态资源的文件列表

        // 开始扫描项目目录
        const result = scanDirSync(basePath, {
          ignore,
          include: static.concat(staticIn),
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

        const totalCount = staticArr.length; // 需要检查的文件总数
        let currentCount = 0; // 当前已检查文件数
        let lastPercent = 0; // 上次进度
        const unusedArr = []; // 未使用的静态资源文件列表
        const rgResult = []; // 队列结果
        const queue = Queue({
          concurrency: 5,
          results: rgResult,
        }); // 创建队列对象

        // 报告进度
        interval = setInterval(() => {
          const percent = parseInt((currentCount / totalCount) * 100);

          progress.report({
            increment: percent - lastPercent,
          });

          lastPercent = percent;
        }, 500);

        if (os.type() === 'Windows_NT') {
          // todo Windows系统下使用rg命令快速全文搜索，注：此种方式有bug，原因未查明，慎用！
          staticArr.forEach((staticFile) => {
            const fileName = path.basename(staticFile);
            const ignoreStr = ignore.reduce((prev, next) => {
              return `${prev}-g "!${next}" `;
            }, ''); // 忽略的目录或文件
            const staticInStr = staticIn.reduce((prev, next) => {
              return `${prev}-g "*${next}" `;
            }, ''); // 引用静态资源文件的文件类型

            const args = `"${fileName}" "${basePath}" -i --hidden --count-matches --no-filename ${ignoreStr} ${staticInStr}`; // 参数字符串
            const argsArr = args.split(' '); // 参数数组

            queue.push(function () {
              // 用户取消时，清空队列
              if (!progressFlag) {
                queue.end();
                return;
              }

              return new Promise((resolve, reject) => {
                execPromise(`"${rgPath}" ${args}`, {
                  shell: true,
                })
                  .then((res) => {
                    const { stdout, stderr, code } = res;

                    if (code === 1 && !stdout && !stderr) {
                      // 未使用时
                      unusedArr.push({
                        path: staticFile,
                        size: fs.statSync(staticFile).size,
                      });
                    }

                    resolve(staticFile); // 表示队列中的某个任务已完成
                  })
                  .catch((err) => {
                    reject(err);
                  })
                  .finally(() => {
                    currentCount++; // 设置已检查文件数量
                  });
              });
            });
          });
        } else {
          // 其它系统时，直接使用node查找
          staticArr.forEach((staticFile) => {
            queue.push(() => {
              // 用户取消时，清空队列
              if (!progressFlag) {
                queue.end();
                return;
              }

              return new Promise((resolve, reject) => {
                const promiseArr = staticInArr.map((staticInFile) => {
                  return fsPromises.readFile(staticInFile, 'utf8');
                });

                Promise.all(promiseArr)
                  .then((res) => {
                    let unused = true;

                    for (let fileContent of res) {
                      if (fileContent.includes(path.basename(staticFile))) {
                        unused = false; // 有使用时
                        break;
                      }
                    }

                    if (unused) {
                      // 未使用时
                      unusedArr.push({
                        path: staticFile,
                        size: fs.statSync(staticFile).size,
                      });
                    }

                    resolve(staticFile); // 表示队列中的某个任务已完成
                  })
                  .catch((err) => {
                    reject(err);
                  })
                  .finally(() => {
                    currentCount++; // 设置已检查文件数量
                  });
              });
            });
          });
        }

        // 开始队列
        queue.start(function (err) {
          clearInterval(interval);

          if (err) {
            console.error(err);
            return;
          }

          if (!progressFlag) {
            console.error('用户取消，队列已清空！');
            return;
          }

          // 计算未使用文件总体积
          const totalSize = formatSize(
            unusedArr.reduce((prev, next) => {
              return prev + next.size;
            }, 0),
          );

          // 未使用文件按体积从大到小排序
          unusedArr.sort((a, b) => {
            return b.size - a.size;
          });

          // 格式化未使用文件的体积
          unusedArr.forEach((item) => {
            item.size = formatSize(item.size);
          });

          // 写入文件
          fs.writeFileSync(unusedJson, JSON.stringify(unusedArr, null, 2));

          vscode.window.showInformationMessage(
            `找到未使用的静态资源文件共${
              unusedArr.length
            }个，总体积为：${totalSize}，用时：${formatTime(
              Date.now() - startTime,
            )}`,
          );

          // 打开文件
          vscode.workspace
            .openTextDocument(vscode.Uri.file(unusedJson))
            .then((doc) => vscode.window.showTextDocument(doc));

          resolve(); // 关闭withProgress窗口
        });
      });
    },
  );
}

// 删除文件
function deleteFile() {
  if (vscode.workspace.workspaceFolders.length > 1) {
    vscode.window.showErrorMessage(
      '此扩展只支持一个工作区目录，您的项目中含有多个工作区目录！',
    );
    return;
  }

  const basePath = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const unusedJson = path.join(basePath, 'unused.json');

  if (!fs.pathExistsSync(unusedJson)) {
    vscode.window.showErrorMessage('项目根目录下未找到unused.json文件！');
    return;
  }

  vscode.window
    .showInputBox({
      prompt:
        "Find Unused: 请输入'yes'来确认删除unused.json列表中的文件（在此操作前请自行备份好文件)",
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
          '已删除unused.json列表中的所有文件！',
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

/**
 * 格式化时间
 * @param {*} time 需要格式化的时间，单位为ms
 * @returns
 */
function formatTime(time, outputType = 'String') {
  const maxHour = 24 * 60 * 60 * 1000;
  const maxMinute = 60 * 60 * 1000;
  const maxSecond = 60 * 1000;
  const maxMillisecond = 1000;
  let day = 0;
  let hour = 0;
  let minute = 0;
  let second = 0;
  let millisecond = 0;
  let remainder = 0;

  // 计算天数
  day = parseInt(time / maxHour);
  remainder = time % maxHour;

  if (remainder > 0) {
    // 计算小时
    hour = parseInt(remainder / maxMinute);
    remainder %= maxMinute;

    if (remainder > 0) {
      // 计算分钟
      minute = parseInt(remainder / maxSecond);
      remainder %= maxSecond;

      if (remainder > 0) {
        // 计算秒数
        second = parseInt(remainder / maxMillisecond);
        remainder %= maxMillisecond;

        // 计算毫秒数
        millisecond = remainder;
      }
    }
  }

  // 返回字符串
  if ((outputType = 'String')) {
    day = day > 0 ? `${day}天` : '';
    hour = hour > 0 ? `${hour}小时` : '';
    minute = minute > 0 ? `${minute}分钟` : '';
    second = second > 0 ? `${second}秒` : '';
    millisecond = millisecond > 0 ? `${millisecond}毫秒` : '';

    if (time >= 1000) {
      return `${day}${hour}${minute}${second}`;
    }

    return `${day}${hour}${minute}${second}${millisecond}`;
  }

  // 返回对象
  return {
    day,
    hour,
    minute,
    second,
    millisecond,
  };
}

/**
 * child_process.spawn的promise化
 * @param {*} command
 * @param {*} [args=[]]
 * @param {*} [options={}]
 * @returns
 */
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

    // https://stackoverflow.com/questions/37522010/difference-between-childprocess-close-exit-events
    commandSpawn.on('exit', (code) => {
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

/**
 * child_process.exec的promise化
 * @param {*} command
 * @param {*} [options={}]
 * @returns
 */
function execPromise(command, options = {}) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';

    const commandExec = exec(command, Object.assign({}, options));

    commandExec.stdout.on('data', (data) => {
      stdout = `${stdout}${data}`;
    });

    commandExec.stderr.on('data', (data) => {
      stderr = `${stderr}${data}`;
    });

    // https://stackoverflow.com/questions/37522010/difference-between-childprocess-close-exit-events
    commandExec.on('exit', (code) => {
      resolve({
        stdout,
        stderr,
        code,
      });
    });

    commandExec.on('error', (error) => {
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
