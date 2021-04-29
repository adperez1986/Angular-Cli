/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import { UnsuccessfulWorkflowExecution } from '@angular-devkit/schematics';
import { NodeWorkflow } from '@angular-devkit/schematics/tools';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as semver from 'semver';
import { PackageManager } from '../lib/config/workspace-schema';
import { Command } from '../models/command';
import { Arguments } from '../models/interface';
import { SchematicEngineHost } from '../models/schematic-engine-host';
import { colors } from '../utilities/color';
import { runTempPackageBin } from '../utilities/install-package';
import { writeErrorToLogFile } from '../utilities/log-file';
import { ensureCompatibleNpm, getPackageManager } from '../utilities/package-manager';
import {
  PackageIdentifier,
  PackageManifest,
  PackageMetadata,
  fetchPackageManifest,
  fetchPackageMetadata,
} from '../utilities/package-metadata';
import {
  PackageTreeNode,
  findPackageJson,
  getProjectDependencies,
  readPackageJson,
} from '../utilities/package-tree';
import { Schema as UpdateCommandSchema } from './update';

const npa = require('npm-package-arg') as (selector: string) => PackageIdentifier;
const pickManifest = require('npm-pick-manifest') as (
  metadata: PackageMetadata,
  selector: string,
) => PackageManifest;

const NG_VERSION_9_POST_MSG = colors.cyan(
  '\nYour project has been updated to Angular version 9!\n' +
    'For more info, please see: https://v9.angular.io/guide/updating-to-version-9',
);

const UPDATE_SCHEMATIC_COLLECTION = path.join(
  __dirname,
  '../src/commands/update/schematic/collection.json',
);

/**
 * Disable CLI version mismatch checks and forces usage of the invoked CLI
 * instead of invoking the local installed version.
 */
const disableVersionCheckEnv = process.env['NG_DISABLE_VERSION_CHECK'];
const disableVersionCheck =
  disableVersionCheckEnv !== undefined &&
  disableVersionCheckEnv !== '0' &&
  disableVersionCheckEnv.toLowerCase() !== 'false';

export class UpdateCommand extends Command<UpdateCommandSchema> {
  public readonly allowMissingWorkspace = true;
  private workflow!: NodeWorkflow;
  private packageManager = PackageManager.Npm;

  async initialize() {
    this.packageManager = await getPackageManager(this.context.root);
    this.workflow = new NodeWorkflow(this.context.root, {
      packageManager: this.packageManager,
      // __dirname -> favor @schematics/update from this package
      // Otherwise, use packages from the active workspace (migrations)
      resolvePaths: [__dirname, this.context.root],
      schemaValidation: true,
      engineHostCreator: (options) => new SchematicEngineHost(options.resolvePaths),
    });
  }

  private async executeSchematic(
    collection: string,
    schematic: string,
    options = {},
  ): Promise<{ success: boolean; files: Set<string> }> {
    let error = false;
    let logs: string[] = [];
    const files = new Set<string>();

    const reporterSubscription = this.workflow.reporter.subscribe((event) => {
      // Strip leading slash to prevent confusion.
      const eventPath = event.path.startsWith('/') ? event.path.substr(1) : event.path;

      switch (event.kind) {
        case 'error':
          error = true;
          const desc = event.description == 'alreadyExist' ? 'already exists' : 'does not exist.';
          this.logger.error(`ERROR! ${eventPath} ${desc}.`);
          break;
        case 'update':
          logs.push(`${colors.cyan('UPDATE')} ${eventPath} (${event.content.length} bytes)`);
          files.add(eventPath);
          break;
        case 'create':
          logs.push(`${colors.green('CREATE')} ${eventPath} (${event.content.length} bytes)`);
          files.add(eventPath);
          break;
        case 'delete':
          logs.push(`${colors.yellow('DELETE')} ${eventPath}`);
          files.add(eventPath);
          break;
        case 'rename':
          const eventToPath = event.to.startsWith('/') ? event.to.substr(1) : event.to;
          logs.push(`${colors.blue('RENAME')} ${eventPath} => ${eventToPath}`);
          files.add(eventPath);
          break;
      }
    });

    const lifecycleSubscription = this.workflow.lifeCycle.subscribe((event) => {
      if (event.kind == 'end' || event.kind == 'post-tasks-start') {
        if (!error) {
          // Output the logging queue, no error happened.
          logs.forEach((log) => this.logger.info(`  ${log}`));
          logs = [];
        }
      }
    });

    // TODO: Allow passing a schematic instance directly
    try {
      await this.workflow
        .execute({
          collection,
          schematic,
          options,
          logger: this.logger,
        })
        .toPromise();

      reporterSubscription.unsubscribe();
      lifecycleSubscription.unsubscribe();

      return { success: !error, files };
    } catch (e) {
      if (e instanceof UnsuccessfulWorkflowExecution) {
        this.logger.error(
          `${colors.symbols.cross} Migration failed. See above for further details.\n`,
        );
      } else {
        const logPath = writeErrorToLogFile(e);
        this.logger.fatal(
          `${colors.symbols.cross} Migration failed: ${e.message}\n` +
            `  See "${logPath}" for further details.\n`,
        );
      }

      return { success: false, files };
    }
  }

  /**
   * @return Whether or not the migration was performed successfully.
   */
  private async executeMigration(
    packageName: string,
    collectionPath: string,
    migrationName: string,
    commit?: boolean,
  ): Promise<boolean> {
    const collection = this.workflow.engine.createCollection(collectionPath);
    const name = collection.listSchematicNames().find((name) => name === migrationName);
    if (!name) {
      this.logger.error(`Cannot find migration '${migrationName}' in '${packageName}'.`);

      return false;
    }

    const schematic = this.workflow.engine.createSchematic(name, collection);

    this.logger.info(
      colors.cyan(`** Executing '${migrationName}' of package '${packageName}' **\n`),
    );

    return this.executePackageMigrations([schematic.description], packageName, commit);
  }

  /**
   * @return Whether or not the migrations were performed successfully.
   */
  private async executeMigrations(
    packageName: string,
    collectionPath: string,
    from: string,
    to: string,
    commit?: boolean,
  ): Promise<boolean> {
    const collection = this.workflow.engine.createCollection(collectionPath);
    const migrationRange = new semver.Range(
      '>' + (semver.prerelease(from) ? from.split('-')[0] + '-0' : from) + ' <=' + to,
    );
    const migrations = [];

    for (const name of collection.listSchematicNames()) {
      const schematic = this.workflow.engine.createSchematic(name, collection);
      const description = schematic.description as typeof schematic.description & {
        version?: string;
      };
      description.version = coerceVersionNumber(description.version) || undefined;
      if (!description.version) {
        continue;
      }

      if (semver.satisfies(description.version, migrationRange, { includePrerelease: true })) {
        migrations.push(description as typeof schematic.description & { version: string });
      }
    }

    migrations.sort((a, b) => semver.compare(a.version, b.version) || a.name.localeCompare(b.name));

    if (migrations.length === 0) {
      return true;
    }

    this.logger.info(colors.cyan(`** Executing migrations of package '${packageName}' **\n`));

    return this.executePackageMigrations(migrations, packageName, commit);
  }

  private async executePackageMigrations(
    migrations: Iterable<{ name: string; description: string; collection: { name: string } }>,
    packageName: string,
    commit = false,
  ): Promise<boolean> {
    for (const migration of migrations) {
      const [title, ...description] = migration.description.split('. ');

      this.logger.info(
        colors.cyan(colors.symbols.pointer) +
          ' ' +
          colors.bold(title.endsWith('.') ? title : title + '.'),
      );

      if (description.length) {
        this.logger.info('  ' + description.join('.\n  '));
      }

      const result = await this.executeSchematic(migration.collection.name, migration.name);
      if (!result.success) {
        return false;
      }

      this.logger.info('  Migration completed.');

      // Commit migration
      if (commit) {
        const commitPrefix = `${packageName} migration - ${migration.name}`;
        const commitMessage = migration.description
          ? `${commitPrefix}\n\n${migration.description}`
          : commitPrefix;
        const committed = this.commit(commitMessage);
        if (!committed) {
          // Failed to commit, something went wrong. Abort the update.
          return false;
        }
      }

      this.logger.info(''); // Extra trailing newline.
    }

    return true;
  }

  // eslint-disable-next-line max-lines-per-function
  async run(options: UpdateCommandSchema & Arguments) {
    await ensureCompatibleNpm(this.context.root);

    // Check if the current installed CLI version is older than the latest version.
    if (!disableVersionCheck && (await this.checkCLILatestVersion(options.verbose, options.next))) {
      this.logger.warn(
        `The installed local Angular CLI version is older than the latest ${
          options.next ? 'pre-release' : 'stable'
        } version.\n` + 'Installing a temporary version to perform the update.',
      );

      return runTempPackageBin(
        `@angular/cli@${options.next ? 'next' : 'latest'}`,
        this.logger,
        this.packageManager,
        process.argv.slice(2),
      );
    }

    const logVerbose = (message: string) => {
      if (options.verbose) {
        this.logger.info(message);
      }
    };

    if (options.all) {
      const updateCmd =
        this.packageManager === PackageManager.Yarn
          ? `'yarn upgrade-interactive' or 'yarn upgrade'`
          : `'${this.packageManager} update'`;

      this.logger.warn(`
        '--all' functionality has been removed as updating multiple packages at once is not recommended.
        To update packages which don’t provide 'ng update' capabilities in your workspace 'package.json' use ${updateCmd} instead.
        Run the package manager update command after updating packages which provide 'ng update' capabilities.
      `);

      return 0;
    }

    const packages: PackageIdentifier[] = [];
    for (const request of options['--'] || []) {
      try {
        const packageIdentifier = npa(request);

        // only registry identifiers are supported
        if (!packageIdentifier.registry) {
          this.logger.error(`Package '${request}' is not a registry package identifer.`);

          return 1;
        }

        if (packages.some((v) => v.name === packageIdentifier.name)) {
          this.logger.error(`Duplicate package '${packageIdentifier.name}' specified.`);

          return 1;
        }

        if (options.migrateOnly && packageIdentifier.rawSpec) {
          this.logger.warn('Package specifier has no effect when using "migrate-only" option.');
        }

        // If next option is used and no specifier supplied, use next tag
        if (options.next && !packageIdentifier.rawSpec) {
          packageIdentifier.fetchSpec = 'next';
        }

        packages.push(packageIdentifier);
      } catch (e) {
        this.logger.error(e.message);

        return 1;
      }
    }

    if (!options.migrateOnly && (options.from || options.to)) {
      this.logger.error('Can only use "from" or "to" options with "migrate-only" option.');

      return 1;
    }

    // If not asking for status then check for a clean git repository.
    // This allows the user to easily reset any changes from the update.
    if (packages.length && !this.checkCleanGit()) {
      if (options.allowDirty) {
        this.logger.warn(
          'Repository is not clean. Update changes will be mixed with pre-existing changes.',
        );
      } else {
        this.logger.error(
          'Repository is not clean. Please commit or stash any changes before updating.',
        );

        return 2;
      }
    }

    this.logger.info(`Using package manager: '${this.packageManager}'`);
    this.logger.info('Collecting installed dependencies...');

    const rootDependencies = await getProjectDependencies(this.context.root);

    this.logger.info(`Found ${rootDependencies.size} dependencies.`);

    if (packages.length === 0) {
      // Show status
      const { success } = await this.executeSchematic(UPDATE_SCHEMATIC_COLLECTION, 'update', {
        force: options.force || false,
        next: options.next || false,
        verbose: options.verbose || false,
        packageManager: this.packageManager,
        packages: [],
      });

      return success ? 0 : 1;
    }

    if (options.migrateOnly) {
      if (!options.from && typeof options.migrateOnly !== 'string') {
        this.logger.error(
          '"from" option is required when using the "migrate-only" option without a migration name.',
        );

        return 1;
      } else if (packages.length !== 1) {
        this.logger.error(
          'A single package must be specified when using the "migrate-only" option.',
        );

        return 1;
      }

      if (options.next) {
        this.logger.warn('"next" option has no effect when using "migrate-only" option.');
      }

      const packageName = packages[0].name;
      const packageDependency = rootDependencies.get(packageName);
      let packagePath = packageDependency?.path;
      let packageNode = packageDependency?.package;
      if (packageDependency && !packageNode) {
        this.logger.error('Package found in package.json but is not installed.');

        return 1;
      } else if (!packageDependency) {
        // Allow running migrations on transitively installed dependencies
        // There can technically be nested multiple versions
        // TODO: If multiple, this should find all versions and ask which one to use
        const packageJson = findPackageJson(this.context.root, packageName);
        if (packageJson) {
          packagePath = path.dirname(packageJson);
          packageNode = await readPackageJson(packageJson);
        }
      }

      if (!packageNode || !packagePath) {
        this.logger.error('Package is not installed.');

        return 1;
      }

      const updateMetadata = packageNode['ng-update'];
      let migrations = updateMetadata?.migrations;
      if (migrations === undefined) {
        this.logger.error('Package does not provide migrations.');

        return 1;
      } else if (typeof migrations !== 'string') {
        this.logger.error('Package contains a malformed migrations field.');

        return 1;
      } else if (path.posix.isAbsolute(migrations) || path.win32.isAbsolute(migrations)) {
        this.logger.error(
          'Package contains an invalid migrations field. Absolute paths are not permitted.',
        );

        return 1;
      }

      // Normalize slashes
      migrations = migrations.replace(/\\/g, '/');

      if (migrations.startsWith('../')) {
        this.logger.error(
          'Package contains an invalid migrations field. ' +
            'Paths outside the package root are not permitted.',
        );

        return 1;
      }

      // Check if it is a package-local location
      const localMigrations = path.join(packagePath, migrations);
      if (fs.existsSync(localMigrations)) {
        migrations = localMigrations;
      } else {
        // Try to resolve from package location.
        // This avoids issues with package hoisting.
        try {
          migrations = require.resolve(migrations, { paths: [packagePath] });
        } catch (e) {
          if (e.code === 'MODULE_NOT_FOUND') {
            this.logger.error('Migrations for package were not found.');
          } else {
            this.logger.error(`Unable to resolve migrations for package.  [${e.message}]`);
          }

          return 1;
        }
      }

      let success = false;
      if (typeof options.migrateOnly == 'string') {
        success = await this.executeMigration(
          packageName,
          migrations,
          options.migrateOnly,
          options.createCommits,
        );
      } else {
        const from = coerceVersionNumber(options.from);
        if (!from) {
          this.logger.error(`"from" value [${options.from}] is not a valid version.`);

          return 1;
        }

        success = await this.executeMigrations(
          packageName,
          migrations,
          from,
          options.to || packageNode.version,
          options.createCommits,
        );
      }

      if (success) {
        if (
          packageName === '@angular/core' &&
          options.from &&
          +options.from.split('.')[0] < 9 &&
          (options.to || packageNode.version).split('.')[0] === '9'
        ) {
          this.logger.info(NG_VERSION_9_POST_MSG);
        }

        return 0;
      }

      return 1;
    }

    const requests: {
      identifier: PackageIdentifier;
      node: PackageTreeNode;
    }[] = [];

    // Validate packages actually are part of the workspace
    for (const pkg of packages) {
      const node = rootDependencies.get(pkg.name);
      if (!node?.package) {
        this.logger.error(`Package '${pkg.name}' is not a dependency.`);

        return 1;
      }

      // If a specific version is requested and matches the installed version, skip.
      if (pkg.type === 'version' && node.package.version === pkg.fetchSpec) {
        this.logger.info(`Package '${pkg.name}' is already at '${pkg.fetchSpec}'.`);
        continue;
      }

      requests.push({ identifier: pkg, node });
    }

    if (requests.length === 0) {
      return 0;
    }

    const packagesToUpdate: string[] = [];

    this.logger.info('Fetching dependency metadata from registry...');
    for (const { identifier: requestIdentifier, node } of requests) {
      const packageName = requestIdentifier.name;

      let metadata;
      try {
        // Metadata requests are internally cached; multiple requests for same name
        // does not result in additional network traffic
        metadata = await fetchPackageMetadata(packageName, this.logger, {
          verbose: options.verbose,
        });
      } catch (e) {
        this.logger.error(`Error fetching metadata for '${packageName}': ` + e.message);

        return 1;
      }

      // Try to find a package version based on the user requested package specifier
      // registry specifier types are either version, range, or tag
      let manifest: PackageManifest | undefined;
      if (
        requestIdentifier.type === 'version' ||
        requestIdentifier.type === 'range' ||
        requestIdentifier.type === 'tag'
      ) {
        try {
          manifest = pickManifest(metadata, requestIdentifier.fetchSpec);
        } catch (e) {
          if (e.code === 'ETARGET') {
            // If not found and next was used and user did not provide a specifier, try latest.
            // Package may not have a next tag.
            if (
              requestIdentifier.type === 'tag' &&
              requestIdentifier.fetchSpec === 'next' &&
              !requestIdentifier.rawSpec
            ) {
              try {
                manifest = pickManifest(metadata, 'latest');
              } catch (e) {
                if (e.code !== 'ETARGET' && e.code !== 'ENOVERSIONS') {
                  throw e;
                }
              }
            }
          } else if (e.code !== 'ENOVERSIONS') {
            throw e;
          }
        }
      }

      if (!manifest) {
        this.logger.error(
          `Package specified by '${requestIdentifier.raw}' does not exist within the registry.`,
        );

        return 1;
      }

      if (node.package?.name === '@angular/cli') {
        // Migrations for non LTS versions of Angular CLI are no longer included in @schematics/angular v12.
        const toBeInstalledMajorVersion = +manifest.version.split('.')[0];
        const currentMajorVersion = +node.package.version.split('.')[0];
        if (currentMajorVersion < 9 && toBeInstalledMajorVersion >= 12) {
          const updateVersions: Record<number, number> = {
            1: 6,
            6: 7,
            7: 8,
            8: 9,
          };

          const updateTo = updateVersions[currentMajorVersion];
          this.logger.error(
            'Updating multiple major versions at once is not recommended. ' +
              `Run 'ng update @angular/cli@${updateTo}' in your workspace directory ` +
              `to update to latest '${updateTo}.x' version of '@angular/cli'.\n\n` +
              'For more information about the update process, see https://update.angular.io/.',
          );

          return 1;
        }
      }

      if (manifest.version === node.package?.version) {
        this.logger.info(`Package '${packageName}' is already up to date.`);
        continue;
      }

      packagesToUpdate.push(requestIdentifier.toString());
    }

    if (packagesToUpdate.length === 0) {
      return 0;
    }

    const { success } = await this.executeSchematic(UPDATE_SCHEMATIC_COLLECTION, 'update', {
      verbose: options.verbose || false,
      force: options.force || false,
      next: !!options.next,
      packageManager: this.packageManager,
      packages: packagesToUpdate,
    });

    if (success && options.createCommits) {
      const committed = this.commit(
        `Angular CLI update for packages - ${packagesToUpdate.join(', ')}`,
      );
      if (!committed) {
        return 1;
      }
    }

    // This is a temporary workaround to allow data to be passed back from the update schematic
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const migrations = (global as any).externalMigrations as {
      package: string;
      collection: string;
      from: string;
      to: string;
    }[];

    if (success && migrations) {
      for (const migration of migrations) {
        // Resolve the package from the workspace root, as otherwise it will be resolved from the temp
        // installed CLI version.
        let packagePath;
        logVerbose(
          `Resolving migration package '${migration.package}' from '${this.context.root}'...`,
        );
        try {
          try {
            packagePath = path.dirname(
              // This may fail if the `package.json` is not exported as an entry point
              require.resolve(path.join(migration.package, 'package.json'), {
                paths: [this.context.root],
              }),
            );
          } catch (e) {
            if (e.code === 'MODULE_NOT_FOUND') {
              // Fallback to trying to resolve the package's main entry point
              packagePath = require.resolve(migration.package, { paths: [this.context.root] });
            } else {
              throw e;
            }
          }
        } catch (e) {
          if (e.code === 'MODULE_NOT_FOUND') {
            logVerbose(e.toString());
            this.logger.error(
              `Migrations for package (${migration.package}) were not found.` +
                ' The package could not be found in the workspace.',
            );
          } else {
            this.logger.error(
              `Unable to resolve migrations for package (${migration.package}).  [${e.message}]`,
            );
          }

          return 1;
        }

        let migrations;

        // Check if it is a package-local location
        const localMigrations = path.join(packagePath, migration.collection);
        if (fs.existsSync(localMigrations)) {
          migrations = localMigrations;
        } else {
          // Try to resolve from package location.
          // This avoids issues with package hoisting.
          try {
            migrations = require.resolve(migration.collection, { paths: [packagePath] });
          } catch (e) {
            if (e.code === 'MODULE_NOT_FOUND') {
              this.logger.error(`Migrations for package (${migration.package}) were not found.`);
            } else {
              this.logger.error(
                `Unable to resolve migrations for package (${migration.package}).  [${e.message}]`,
              );
            }

            return 1;
          }
        }
        const result = await this.executeMigrations(
          migration.package,
          migrations,
          migration.from,
          migration.to,
          options.createCommits,
        );

        if (!result) {
          return 0;
        }
      }

      if (
        migrations.some(
          (m) =>
            m.package === '@angular/core' &&
            m.to.split('.')[0] === '9' &&
            +m.from.split('.')[0] < 9,
        )
      ) {
        this.logger.info(NG_VERSION_9_POST_MSG);
      }
    }

    return success ? 0 : 1;
  }

  /**
   * @return Whether or not the commit was successful.
   */
  private commit(message: string): boolean {
    // Check if a commit is needed.
    let commitNeeded: boolean;
    try {
      commitNeeded = hasChangesToCommit();
    } catch (err) {
      this.logger.error(`  Failed to read Git tree:\n${err.stderr}`);

      return false;
    }

    if (!commitNeeded) {
      this.logger.info('  No changes to commit after migration.');

      return true;
    }

    // Commit changes and abort on error.
    try {
      createCommit(message);
    } catch (err) {
      this.logger.error(`Failed to commit update (${message}):\n${err.stderr}`);

      return false;
    }

    // Notify user of the commit.
    const hash = findCurrentGitSha();
    const shortMessage = message.split('\n')[0];
    if (hash) {
      this.logger.info(`  Committed migration step (${getShortHash(hash)}): ${shortMessage}.`);
    } else {
      // Commit was successful, but reading the hash was not. Something weird happened,
      // but nothing that would stop the update. Just log the weirdness and continue.
      this.logger.info(`  Committed migration step: ${shortMessage}.`);
      this.logger.warn('  Failed to look up hash of most recent commit, continuing anyways.');
    }

    return true;
  }

  private checkCleanGit(): boolean {
    try {
      const topLevel = execSync('git rev-parse --show-toplevel', {
        encoding: 'utf8',
        stdio: 'pipe',
      });
      const result = execSync('git status --porcelain', { encoding: 'utf8', stdio: 'pipe' });
      if (result.trim().length === 0) {
        return true;
      }

      // Only files inside the workspace root are relevant
      for (const entry of result.split('\n')) {
        const relativeEntry = path.relative(
          path.resolve(this.context.root),
          path.resolve(topLevel.trim(), entry.slice(3).trim()),
        );

        if (!relativeEntry.startsWith('..') && !path.isAbsolute(relativeEntry)) {
          return false;
        }
      }
    } catch {}

    return true;
  }

  /**
   * Checks if the current installed CLI version is older than the latest version.
   * @returns `true` when the installed version is older.
   */
  private async checkCLILatestVersion(verbose = false, next = false): Promise<boolean> {
    const { version: installedCLIVersion } = require('../package.json');

    const LatestCLIManifest = await fetchPackageManifest(
      `@angular/cli@${next ? 'next' : 'latest'}`,
      this.logger,
      {
        verbose,
        usingYarn: this.packageManager === PackageManager.Yarn,
      },
    );

    return semver.lt(installedCLIVersion, LatestCLIManifest.version);
  }
}

/**
 * @return Whether or not the working directory has Git changes to commit.
 */
function hasChangesToCommit(): boolean {
  // List all modified files not covered by .gitignore.
  const files = execSync('git ls-files -m -d -o --exclude-standard').toString();

  // If any files are returned, then there must be something to commit.
  return files !== '';
}

/**
 * Precondition: Must have pending changes to commit, they do not need to be staged.
 * Postcondition: The Git working tree is committed and the repo is clean.
 * @param message The commit message to use.
 */
function createCommit(message: string) {
  // Stage entire working tree for commit.
  execSync('git add -A', { encoding: 'utf8', stdio: 'pipe' });

  // Commit with the message passed via stdin to avoid bash escaping issues.
  execSync('git commit --no-verify -F -', { encoding: 'utf8', stdio: 'pipe', input: message });
}

/**
 * @return The Git SHA hash of the HEAD commit. Returns null if unable to retrieve the hash.
 */
function findCurrentGitSha(): string | null {
  try {
    const hash = execSync('git rev-parse HEAD', { encoding: 'utf8', stdio: 'pipe' });

    return hash.trim();
  } catch {
    return null;
  }
}

function getShortHash(commitHash: string): string {
  return commitHash.slice(0, 9);
}

function coerceVersionNumber(version: string | undefined): string | null {
  if (!version) {
    return null;
  }

  if (!version.match(/^\d{1,30}\.\d{1,30}\.\d{1,30}/)) {
    const match = version.match(/^\d{1,30}(\.\d{1,30})*/);

    if (!match) {
      return null;
    }

    if (!match[1]) {
      version = version.substr(0, match[0].length) + '.0.0' + version.substr(match[0].length);
    } else if (!match[2]) {
      version = version.substr(0, match[0].length) + '.0' + version.substr(match[0].length);
    } else {
      return null;
    }
  }

  return semver.valid(version);
}
