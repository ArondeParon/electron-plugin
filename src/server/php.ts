import {mkdirSync, statSync, writeFileSync, existsSync} from 'fs'
import {copySync} from 'fs-extra'
import Store from 'electron-store'
import {promisify} from 'util'
import {join} from 'path'
import {app} from 'electron'
import {exec, execFile, spawn} from 'child_process'
import state from "./state";
import getPort from 'get-port';
import { ProcessResult } from "./ProcessResult";

const storagePath = join(app.getPath('userData'), 'storage')
const databasePath = join(app.getPath('userData'), 'database')
const databaseFile = join(databasePath, 'database.sqlite')
const argumentEnv = getArgumentEnv();
const appPath = getAppPath();

async function getPhpPort() {
    return await getPort({
        port: getPort.makeRange(8100, 9000)
    });
}

async function retrieveNativePHPConfig() {
    const env = {
        NATIVEPHP_STORAGE_PATH: storagePath,
        NATIVEPHP_DATABASE_PATH: databaseFile,
    };

    const phpOptions = {
        cwd: appPath,
        env
    };

    return await promisify(execFile)(state.php, ['artisan', 'native:config'], phpOptions);
}

function callPhp(args, options) {
    return spawn(
        state.php,
        args,
        {
            cwd: options.cwd,
            env: {
                ...process.env,
                ...options.env
            },
        }
    );
}

function getArgumentEnv() {
    const envArgs = process.argv.filter(arg => arg.startsWith('--env.'));

    const env: {
      TESTING?: number,
      APP_PATH?: string
    } = {

    };
    envArgs.forEach(arg => {
        const [key, value] = arg.slice(6).split('=');
        env[key] = value;
    });

    return env;
}

function getAppPath() {
    let appPath = join(__dirname, '../../resources/app/').replace('app.asar', 'app.asar.unpacked')

    if (process.env.NODE_ENV === 'development' || argumentEnv.TESTING == 1) {
        appPath = process.env.APP_PATH || argumentEnv.APP_PATH;
    }
    return appPath;
}

function ensureAppFoldersAreAvailable() {
    if (! existsSync(storagePath)) {
        copySync(join(appPath, 'storage'), storagePath)
    }

    mkdirSync(databasePath, {recursive: true})

    // Create a database file if it doesn't exist
    try {
        statSync(databaseFile)
    } catch (error) {
        writeFileSync(databaseFile, '')
    }
}

function startQueueWorker(secret, apiPort) {
    const env = {
        NATVEPHP_STORAGE_PATH: storagePath,
        NATVEPHP_DATABASE_PATH: databaseFile,
        NATVEPHP_API_URL: `http://localhost:${apiPort}/api/`,
        NATVEPHP_RUNNING: true,
        NATIVEPHP_SECRET: secret
    };

    const phpOptions = {
        cwd: appPath,
        env
    };

    return callPhp(['artisan', 'queue:work'], phpOptions);
}

function startScheduler(secret, apiPort) {
    const env = {
        NATIVEPHP_STORAGE_PATH: storagePath,
        NATIVEPHP_DATABASE_PATH: databaseFile,
        NATIVEPHP_API_URL: `http://localhost:${apiPort}/api/`,
        NATIVEPHP_RUNNING: true,
        NATIVEPHP_SECRET: secret
    };

    const phpOptions = {
        cwd: appPath,
        env
    };

    return callPhp(['artisan', 'schedule:run'], phpOptions);
}

function serveApp(secret, apiPort): Promise<ProcessResult> {
    return new Promise(async (resolve, reject) => {
        const appPath = getAppPath();

        console.log('Starting PHP server...', `${state.php} artisan serve`, appPath)

        ensureAppFoldersAreAvailable();

        console.log('Making sure app folders are available')

        const env = {
            NATIVEPHP_STORAGE_PATH: storagePath,
            NATIVEPHP_DATABASE_PATH: databaseFile,
            NATIVEPHP_API_URL: `http://localhost:${apiPort}/api/`,
            NATIVEPHP_RUNNING: true,
            NATIVEPHP_SECRET: secret,
        };

        const phpOptions = {
            cwd: appPath,
            env
        };

        const store = new Store();

        // Make sure the storage path is linked - as people can move the app around, we
        // need to run this every time the app starts
        callPhp(['artisan', 'storage:link', '--force'], phpOptions)

        // Migrate the database
        if (store.get('migrated_version') !== app.getVersion() || process.env.NODE_ENV === 'development') {
            console.log('Migrating database...')
            callPhp(['artisan', 'migrate', '--force'], phpOptions)
            store.set('migrated_version', app.getVersion())
        } else {
            console.log('Database already migrated', store.get('migrated_version'))
        }

        const phpPort = await getPhpPort();

        const serverPath = join(appPath, 'vendor', 'laravel', 'framework', 'src', 'Illuminate', 'Foundation', 'resources', 'server.php')
        const phpServer = callPhp(['-S', `127.0.0.1:${phpPort}`, serverPath], {
            cwd: join(appPath, 'public'),
            env
        })

        const portRegex = /Development Server \(.*:([0-9]+)\) started/gm

        phpServer.stdout.on('data', (data) => {
            const match = portRegex.exec(data.toString())
            if (match) {
                console.log("PHP Server started on port: ", match[1])
                const port = parseInt(match[1])
                resolve({
                    port,
                    process: phpServer
                })
            }
        })

        phpServer.stderr.on('data', (data) => {
            console.log(data.toString())
            const match = portRegex.exec(data.toString())
            if (match) {
                const port = parseInt(match[1])
                console.log("PHP Server started on port: ", port)
                resolve({
                    port,
                    process: phpServer
                })
            }
        })

        phpServer.on('error', (error) => {
            reject(error)
        })
    })
}

export {startQueueWorker, startScheduler, serveApp, getAppPath, retrieveNativePHPConfig}
