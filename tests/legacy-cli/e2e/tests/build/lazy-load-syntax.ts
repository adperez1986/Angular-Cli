/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import { readFile, replaceInFile, writeFile } from '../../utils/fs';
import { ng } from '../../utils/process';
import { updateJsonFile } from '../../utils/project';

export default async function () {
  const projectName = 'test-project';
  const appRoutingModulePath = 'src/app/app-routing.module.ts';

  const originalAppRoutingModule = await readFile(appRoutingModulePath);
  // helper to replace loadChildren
  const replaceLoadChildren = async (route: string) => {
    const content = originalAppRoutingModule.replace(
      'const routes: Routes = [];',
      `
       const routes: Routes = [{ path: 'lazy', loadChildren: ${route} }];
      `,
    );

    return writeFile(appRoutingModulePath, content);
  };

  // Add lazy route.
  await ng('generate', 'module', 'lazy', '--routing');
  await ng('generate', 'component', 'lazy/lazy-comp');
  await replaceInFile(
    'src/app/lazy/lazy-routing.module.ts',
    'const routes: Routes = [];',
    `
      import { LazyCompComponent } from './lazy-comp/lazy-comp.component';
      const routes: Routes = [{ path: '', component: LazyCompComponent }];
    `,
  );

  // Add lazy route e2e
  await writeFile(
    'e2e/src/app.e2e-spec.ts',
    `
      import { browser, logging, element, by } from 'protractor';

      describe('workspace-project App', () => {
        it('should display lazy route', async () => {
          await browser.get(browser.baseUrl + '/lazy');
          expect(await element(by.css('app-lazy-comp p')).getText()).toEqual('lazy-comp works!');
        });

        afterEach(async () => {
          // Assert that there are no errors emitted from the browser
          const logs = await browser.manage().logs().get(logging.Type.BROWSER);
          expect(logs).not.toContain(jasmine.objectContaining({
            level: logging.Level.SEVERE,
          }));
        });
      });
    `,
  );

  // Convert the default config to use JIT and prod to just do AOT.
  // This way we can use `ng e2e` to test JIT and `ng e2e --configuration=production` to test AOT.
  await updateJsonFile('angular.json', (json) => {
    const buildTarget = json['projects'][projectName]['architect']['build'];
    buildTarget['options']['aot'] = true;
    buildTarget['configurations']['development']['aot'] = false;
  });

  // Test `import()` style lazy load.
  // Both Ivy and View Engine should support it.
  await replaceLoadChildren(`() => import('./lazy/lazy.module').then(m => m.LazyModule)`);

  await ng('e2e');
  await ng('e2e', '--configuration=production');
}
