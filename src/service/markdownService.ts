import { Output } from "@/common/Output";
import { spawn } from 'child_process';
import chromeFinder from 'chrome-finder';
import { copyFileSync, existsSync, lstatSync, mkdirSync, renameSync } from 'fs';
import { homedir } from 'os';
import path, { dirname, extname, isAbsolute, join, parse } from 'path';
import * as vscode from 'vscode';
import { Holder } from './markdown/holder';
import { convertMd } from "./markdown/markdown-pdf";
import { fileTypeFromFile } from 'file-type';

export type ExportType = 'pdf' | 'html' | 'docx';

export class MarkdownService {

    constructor(private context: vscode.ExtensionContext) {
    }

    /**
     * export markdown to another type
     * @param type pdf, html, docx 
     */
    public async exportMarkdown(uri: vscode.Uri, type: ExportType = 'pdf') {
        try {
            if (type == 'pdf') {
                // 其他类型不用, 导出速度很快
                vscode.window.showInformationMessage(`Starting export markdown to ${type}.`)
            }
            await convertMd({ markdownFilePath: uri.fsPath, config: this.getConfig(type) })
            vscode.window.showInformationMessage(`Export markdown to ${type} success!`)
        } catch (error) {
            Output.log(error)
        }
    }

    public getConfig(type: string = 'pdf') {
        const config = vscode.workspace.getConfiguration("vscode-office");
        const top = config.get("pdfMarginTop")
        return {
            type,
            "styles": [],
            // chromium path
            "executablePath": this.getChromiumPath(),
            // Set `true` to convert `\n` in paragraphs into `<br>`.
            "breaks": false,
            // pdf print option
            "printBackground": true,
            format: "A4",
            margin: { top }
        };
    }

    private paths: { [index: string]: string } = {
        stable: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        beta: "C:\\Program Files (x86)\\Microsoft\\Edge Beta\\Application\\msedge.exe",
        dev: "C:\\Program Files (x86)\\Microsoft\\Edge Dev\\Application\\msedge.exe",
        canary: join(homedir(), "AppData\\Local\\Microsoft\\Edge SxS\\Application\\msedge.exe"),
        linux: "/usr/bin/microsoft-edge",
    }

    private getChromiumPath() {
        for (const pathName in this.paths) {
            const path = this.paths[pathName];
            if (existsSync(path)) {
                console.debug(`using edge path is ${path}`)
                return path;
            }
        }
        try {
            const chromePath = chromeFinder();
            console.debug(`using chrome path is ${chromePath}`)
            return chromePath;
        } catch (e) {
            vscode.window.showErrorMessage("Not chromium found, export fail.")
            throw new Error()
        }
    }

    public async loadClipboardImage() {

        const document = vscode.window.activeTextEditor?.document || Holder.activeDocument
        if (await vscode.env.clipboard.readText()) {
            vscode.commands.executeCommand("editor.action.clipboardPasteAction")
            return
        }

        if (!document || document.isUntitled || document.isClosed) {
            return
        }

        const uri: vscode.Uri = document.uri;
        let relPath = vscode.workspace.getConfiguration("vscode-office").get<string>("pasterImgPath");
        relPath = relPath.replace("${fileName}", parse(uri.fsPath).name.replace(/\s/g, '')).replace("${now}", new Date().getTime() + "")
        const absolutePath = isAbsolute(relPath) ? relPath : `${dirname(uri.fsPath)}/${relPath}`.replace(/\\/g, "/");
        this.createImgDir(absolutePath);
        this.saveClipboardImageToFileAndGetPath(absolutePath, async (savedImagePath) => {
            if (!savedImagePath) return;
            if (savedImagePath === 'no image') {
                vscode.window.showErrorMessage('There is not an image in the clipboard.');
                return;
            }
            this.copyFromPath(savedImagePath, absolutePath);
            const editor = vscode.window.activeTextEditor;
            const imgName = parse(relPath).name;
            const oldExt = extname(absolutePath)
            const { ext = "png" } = (await fileTypeFromFile(absolutePath)) ?? {};
            if (oldExt != `.${ext}`) {
                relPath = relPath.replace(oldExt, `.${ext}`)
                renameSync(absolutePath, absolutePath.replace(oldExt, `.${ext}`))
            }
            if (editor) {
                editor?.edit(edit => {
                    let current = editor.selection;
                    if (current.isEmpty) {
                        edit.insert(current.start, `![${imgName}](${relPath})`);
                    } else {
                        edit.replace(current, `![${imgName}](${relPath})`);
                    }
                });
            } else {
                vscode.env.clipboard.writeText(`![${imgName}](${relPath})`)
                vscode.commands.executeCommand("editor.action.clipboardPasteAction")
            }
        })
    }

    /**
     * 如果粘贴板内是复制了一个文件, 取得路径进行复制
     */
    private copyFromPath(savedImagePath: string, targetPath: string) {
        if (savedImagePath.startsWith("copyed:")) {
            const copyedFile = savedImagePath.replace("copyed:", "");
            if (lstatSync(copyedFile).isDirectory()) {
                vscode.window.showErrorMessage('Not support paste directory.');
            } else {
                copyFileSync(copyedFile, targetPath);
            }
        }
    }

    private createImgDir(imagePath: string) {
        const dir = path.dirname(imagePath);
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }
    }

    private saveClipboardImageToFileAndGetPath(imagePath: string, cb: (value: string) => void) {
        if (!imagePath) return;
        let platform = process.platform;
        if (platform === 'win32') {
            // Windows
            const scriptPath = path.join(this.context.extensionPath, '/lib/pc.ps1');
            const powershell = spawn('powershell', [
                '-noprofile',
                '-noninteractive',
                '-nologo',
                '-sta',
                '-executionpolicy', 'unrestricted',
                '-windowstyle', 'hidden',
                '-file', scriptPath,
                imagePath
            ]);
            powershell.on('exit', function (code, signal) {
            });
            powershell.stdout.on('data', function (data) {
                cb(data.toString().trim());
            });
        } else if (platform === 'darwin') {
            // Mac
            let scriptPath = path.join(this.context.extensionPath, './lib/mac.applescript');
            let ascript = spawn('osascript', [scriptPath, imagePath]);
            ascript.on('exit', function (code, signal) {
            });
            ascript.stdout.on('data', function (data) {
                cb(data.toString().trim());
            });
        } else {
            // Linux 
            let scriptPath = path.join(this.context.extensionPath, './lib/linux.sh');

            let ascript = spawn('sh', [scriptPath, imagePath]);
            ascript.on('exit', function (code, signal) {
            });
            ascript.stdout.on('data', function (data) {
                let result = data.toString().trim();
                if (result == "no xclip") {
                    vscode.window.showInformationMessage('You need to install xclip command first.');
                    return;
                }
                cb(result);
            });
        }
    }

}
