import { accessSync, constants, existsSync, statSync } from 'fs';
import { join } from 'path';

const PLATFORM_PACKAGE_BY_TARGET = {
    'x86_64-unknown-linux-musl': '@openai/codex-linux-x64',
    'aarch64-unknown-linux-musl': '@openai/codex-linux-arm64',
    'x86_64-apple-darwin': '@openai/codex-darwin-x64',
    'aarch64-apple-darwin': '@openai/codex-darwin-arm64',
    'x86_64-pc-windows-msvc': '@openai/codex-win32-x64',
    'aarch64-pc-windows-msvc': '@openai/codex-win32-arm64'
};

function isFile(filePath) {
    try {
        return statSync(filePath).isFile();
    } catch {
        return false;
    }
}

export function resolveCodexTargetTriple(platform = process.platform, arch = process.arch) {
    if ((platform === 'linux' || platform === 'android') && arch === 'x64') {
        return 'x86_64-unknown-linux-musl';
    }
    if ((platform === 'linux' || platform === 'android') && arch === 'arm64') {
        return 'aarch64-unknown-linux-musl';
    }
    if (platform === 'darwin' && arch === 'x64') {
        return 'x86_64-apple-darwin';
    }
    if (platform === 'darwin' && arch === 'arm64') {
        return 'aarch64-apple-darwin';
    }
    if (platform === 'win32' && arch === 'x64') {
        return 'x86_64-pc-windows-msvc';
    }
    if (platform === 'win32' && arch === 'arm64') {
        return 'aarch64-pc-windows-msvc';
    }
    return null;
}

export function getCodexCliIntegrity(sdkRootDir, platform = process.platform, arch = process.arch) {
    const targetTriple = resolveCodexTargetTriple(platform, arch);
    if (!targetTriple) {
        return {
            complete: false,
            reason: `Unsupported platform: ${platform} (${arch})`
        };
    }

    const platformPackage = PLATFORM_PACKAGE_BY_TARGET[targetTriple];
    const codexPackageJson = join(sdkRootDir, 'node_modules', '@openai', 'codex', 'package.json');
    if (!existsSync(codexPackageJson)) {
        return {
            complete: false,
            targetTriple,
            platformPackage,
            reason: 'Missing @openai/codex package'
        };
    }

    const platformPackageDir = join(sdkRootDir, 'node_modules', ...platformPackage.split('/'));
    const platformPackageJson = join(platformPackageDir, 'package.json');
    if (!existsSync(platformPackageJson)) {
        return {
            complete: false,
            targetTriple,
            platformPackage,
            reason: `Missing optional dependency ${platformPackage}`
        };
    }

    const binaryName = platform === 'win32' ? 'codex.exe' : 'codex';
    const targetRoot = join(platformPackageDir, 'vendor', targetTriple);
    const packageBinaryPath = join(targetRoot, 'bin', binaryName);
    const packageManifestPath = join(targetRoot, 'codex-package.json');
    const legacyBinaryPath = join(targetRoot, 'codex', binaryName);
    const binaryPath = isFile(packageBinaryPath) && isFile(packageManifestPath)
        ? packageBinaryPath
        : isFile(legacyBinaryPath)
            ? legacyBinaryPath
            : '';
    const checkedPaths = [packageBinaryPath, legacyBinaryPath];

    if (!binaryPath) {
        return {
            complete: false,
            targetTriple,
            platformPackage,
            checkedPaths,
            reason: `Missing Codex CLI binary. Checked: ${checkedPaths.join(', ')}`
        };
    }

    if (platform !== 'win32') {
        try {
            accessSync(binaryPath, constants.X_OK);
        } catch {
            return {
                complete: false,
                targetTriple,
                platformPackage,
                binaryPath,
                checkedPaths,
                reason: `Codex CLI binary is not executable at ${binaryPath}`
            };
        }
    }

    return {
        complete: true,
        targetTriple,
        platformPackage,
        binaryPath,
        checkedPaths
    };
}
