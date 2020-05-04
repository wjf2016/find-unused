const fs = require('fs-extra');
const path = require('path');
const scanDirSync = require('@wujianfu/scan-dir-sync');
const vscode = require('vscode');

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
      const unusedTxt = path.join(basePath, 'unused.txt');
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

        // 由于查找时间较长，这里使用异步方法执行，避免ui卡死
        setTimeout(() => {
          // 查找未使用的静态资源文件
          const unusedArr = [];

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
              unusedArr.push(staticFile);
            }
          }

          progress.report({
            increment: 34,
          });

          console.log(`找到未使用的静态资源文件共${unusedArr.length}个`);

          // 写入文件
          fs.writeFileSync(unusedTxt, unusedArr.join('\n'));

          // 打开文件
          vscode.workspace
            .openTextDocument(vscode.Uri.file(unusedTxt))
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
  const unusedTxt = path.join(basePath, 'unused.txt');

  if (!fs.pathExistsSync(unusedTxt)) {
    vscode.window.showErrorMessage('There is no file named unused.txt!');
    return;
  }

  vscode.window
    .showInputBox({
      prompt:
        "Find Unused: Please enter 'yes' to delete file list in unused.txt. (Please make a backup before you do this.)",
    })
    .then(function (answer) {
      if (answer === 'yes') {
        const fileContentArr = fs.readFileSync(unusedTxt, 'utf-8').split('\n');

        fileContentArr.forEach((file) => {
          if (fs.pathExistsSync(file)) {
            fs.removeSync(file);
          }
        });

        fs.removeSync(unusedTxt);
        vscode.window.showInformationMessage(
          'Deleted all files in unused.txt.',
        );
      }
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
