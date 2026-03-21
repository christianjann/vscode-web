exports.activate = function(context) {
  const vscode = require('vscode');
  context.subscriptions.push(
    vscode.commands.registerCommand('dummy.helloWorld', () => {
      vscode.window.showInformationMessage('Hello from Dummy Extension!');
    })
  );
};
