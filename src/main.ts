#!/usr/bin/env node

import { ValidateFunction } from 'ajv';
import * as findUp from 'find-up';
import * as globby from 'globby';
import * as Ajv from 'ajv';
import * as path from 'path';
import * as _ from 'lodash';
import {
  ClassDeclaration,
  ClassDeclarationStructure,
  DecoratorStructure,
  IndentationText,
  MethodDeclarationStructure,
  NewLineKind,
  OptionalKind,
  Project,
  QuoteKind,
  Scope,
  SourceFile,
} from 'ts-morph';
import { createBody } from './body-builder';
import { ConfigHelper, GeneratorConfig } from './config';
import {
  removeParameterDecorators,
  removeUnsupportedParams,
  unwrapQuotes,
} from './util';

const configFileName = 'nest-sdk-gen.config.json';

(async () => {
  console.log('Reading config...');
  const configPath = await findUp(configFileName);
  if (!configPath) {
    throw new Error(`Could not find ${configFileName}. You must create one. See the docs`);
  }

  const configFileContents: { config: GeneratorConfig } = await import(configPath);
  // @ts-ignore
  const configSchema: any = await import('../config.schema.json');

  const ajv = new Ajv({ allErrors: true });
  const validate: ValidateFunction = ajv.compile(configSchema);
  const valid = validate(configFileContents);

  if (!valid) {
    _.forEach(validate.errors, err => {
      console.error(`${err.dataPath}: ${err.message}`);

      throw new Error('Configuration Errors');
    });
  }

  const config: GeneratorConfig = ConfigHelper.mergeUserConfig(configFileContents.config).get();

  const rootPath = path.dirname(configPath);

  const project = new Project({
    tsConfigFilePath: path.resolve(rootPath, config.tsConfigFilePath),
    manipulationSettings: {
      indentationText: IndentationText.TwoSpaces,
      newLineKind: NewLineKind.LineFeed,
      quoteKind: QuoteKind.Single,
      usePrefixAndSuffixTextForRename: false,
    },
  });

  console.log('Gathering paths...');
  const paths: string[] = _.orderBy(await globby(config.paths), p =>
    p.toLowerCase()
  );

  const baseClientFile: SourceFile = project.addExistingSourceFile(
    path.join(__dirname, `../base-client.ts`)
  );

  baseClientFile.copy(
    path.resolve(rootPath, path.join(config.outputPath, 'base-client.ts')),
    { overwrite: true }
  );

  paths
    .map((filePath) => {
      filePath = path.resolve(rootPath, filePath);
      const classes: ClassDeclaration[] = project
        .addExistingSourceFile(filePath)
        .getClasses();
      return classes.find(cls => cls.getDecorator('Controller'));
    })
    .filter(cls => !!cls)
    .forEach(cls => {
      const serviceName = cls.getName().replace('Controller', 'Client');

      console.log(`Generating client service ${serviceName} for Nest controller ${cls.getName()}...`);

      const clientServiceFile = project.createSourceFile(
        path.resolve(rootPath, path.join(config.outputPath, `${_.kebabCase(serviceName)}.service.ts`)),
        '',
        { overwrite: true }
      );

      clientServiceFile.addImportDeclarations([
        {
          namedImports: ['Injectable'],
          moduleSpecifier: '@angular/core',
        },
        {
          namedImports: ['HttpClient'],
          moduleSpecifier: '@angular/common/http',
        },
        {
          namedImports: ['BaseClient'],
          moduleSpecifier: './base-client',
        },
        ...config.extraImports,
      ]);
    
      const serviceClass = clientServiceFile.addClass({
        name: serviceName,
        isExported: true,
        decorators: [
          {
            name: 'Injectable',
            arguments: config.providedIn
              ? [`{ providedIn: ${config.providedIn} }`]
              : [],
          },
        ],
        extends: 'BaseClient'
      });

      serviceClass
        .addConstructor({
          parameters: [
            {
              name: 'httpClient',
              scope: Scope.Protected,
              type: 'HttpClient',
            },
          ],
        })
        .setOrder(0)
        .setBodyText('super();');

      const classStructure: ClassDeclarationStructure = cls.getStructure();

      const ctrlDec: OptionalKind<DecoratorStructure> = classStructure.decorators.find(
        dec => dec.name === 'Controller'
      );
      // TODO normalize slash
      const baseUrl = config.apiBase + '/' + unwrapQuotes((<string[]>ctrlDec.arguments)[0]);

      classStructure.methods.forEach((methodStructure: MethodDeclarationStructure, index: number) => {
          const body = createBody(
            baseUrl,
            methodStructure
          );

          // if createBody returns null, it's a method we can't process, i.e. doesn't have @Get or is private, or is skipped
          if (!body) {
            return;
          }

          serviceClass.addMethod({
            name: methodStructure.name,
            overloads: methodStructure.overloads,
            parameters: removeParameterDecorators(
              removeUnsupportedParams(
                methodStructure.parameters,
                config.whiteListDecorators
              )
            ),
            statements: body,
          });
        }
      );
      clientServiceFile.fixMissingImports().organizeImports();
    });

  project.save();

})().catch((err) => console.error(err));
