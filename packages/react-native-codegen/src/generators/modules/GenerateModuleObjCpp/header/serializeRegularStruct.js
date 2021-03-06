/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 * @format
 */

'use strict';

const {
  capitalize,
  getSafePropertyName,
  getNamespacedStructName,
} = require('../Utils');

import type {Nullable} from '../../../../CodegenSchema';
import type {StructTypeAnnotation, RegularStruct} from '../StructCollector';
import type {StructSerilizationOutput} from './serializeStruct';

const {unwrapNullable} = require('../../../../parsers/flow/modules/utils');

const StructTemplate = ({
  codegenModuleName,
  structName,
  structProperties,
}: $ReadOnly<{|
  codegenModuleName: string,
  structName: string,
  structProperties: string,
|}>) => `namespace JS {
  namespace ${codegenModuleName} {
    struct ${structName} {
      ${structProperties}

      ${structName}(NSDictionary *const v) : _v(v) {}
    private:
      NSDictionary *_v;
    };
  }
}

@interface RCTCxxConvert (${codegenModuleName}_${structName})
+ (RCTManagedPointer *)JS_${codegenModuleName}_${structName}:(id)json;
@end`;

const MethodTemplate = ({
  returnType,
  returnValue,
  codegenModuleName,
  structName,
  propertyName,
}: $ReadOnly<{|
  returnType: string,
  returnValue: string,
  codegenModuleName: string,
  structName: string,
  propertyName: string,
|}>) => `inline ${returnType}JS::${codegenModuleName}::${structName}::${propertyName}() const
{
  id const p = _v[@"${propertyName}"];
  return ${returnValue};
}`;

function toObjCType(
  codegenModuleName: string,
  nullableTypeAnnotation: Nullable<StructTypeAnnotation>,
  isOptional: boolean = false,
): string {
  const [typeAnnotation, nullable] = unwrapNullable(nullableTypeAnnotation);
  const isRequired = !nullable && !isOptional;
  const wrapFollyOptional = (type: string) => {
    return isRequired ? type : `folly::Optional<${type}>`;
  };

  switch (typeAnnotation.type) {
    case 'ReservedFunctionValueTypeAnnotation':
      switch (typeAnnotation.name) {
        case 'RootTag':
          return wrapFollyOptional('double');
        default:
          (typeAnnotation.name: empty);
          throw new Error(`Unknown prop type, found: ${typeAnnotation.name}"`);
      }
    case 'StringTypeAnnotation':
      return 'NSString *';
    case 'NumberTypeAnnotation':
      return wrapFollyOptional('double');
    case 'FloatTypeAnnotation':
      return wrapFollyOptional('double');
    case 'Int32TypeAnnotation':
      return wrapFollyOptional('double');
    case 'DoubleTypeAnnotation':
      return wrapFollyOptional('double');
    case 'BooleanTypeAnnotation':
      return wrapFollyOptional('bool');
    case 'GenericObjectTypeAnnotation':
      return isRequired ? 'id<NSObject> ' : 'id<NSObject> _Nullable';
    case 'ArrayTypeAnnotation':
      if (typeAnnotation.elementType == null) {
        return isRequired ? 'id<NSObject> ' : 'id<NSObject> _Nullable';
      }
      return wrapFollyOptional(
        `facebook::react::LazyVector<${toObjCType(
          codegenModuleName,
          typeAnnotation.elementType,
        )}>`,
      );
    case 'TypeAliasTypeAnnotation':
      const structName = capitalize(typeAnnotation.name);
      const namespacedStructName = getNamespacedStructName(
        codegenModuleName,
        structName,
      );
      return wrapFollyOptional(namespacedStructName);
    default:
      (typeAnnotation.type: empty);
      throw new Error(
        `Couldn't convert into ObjC type: ${typeAnnotation.type}"`,
      );
  }
}

function toObjCValue(
  codegenModuleName: string,
  nullableTypeAnnotation: Nullable<StructTypeAnnotation>,
  value: string,
  depth: number,
  isOptional: boolean = false,
): string {
  const [typeAnnotation, nullable] = unwrapNullable(nullableTypeAnnotation);
  const isRequired = !nullable && !isOptional;
  const RCTBridgingTo = (type: string, arg?: string) => {
    const args = [value, arg].filter(Boolean).join(', ');
    return isRequired
      ? `RCTBridgingTo${type}(${args})`
      : `RCTBridgingToOptional${type}(${args})`;
  };

  switch (typeAnnotation.type) {
    case 'ReservedFunctionValueTypeAnnotation':
      switch (typeAnnotation.name) {
        case 'RootTag':
          return RCTBridgingTo('Double');
        default:
          (typeAnnotation.name: empty);
          throw new Error(
            `Couldn't convert into ObjC type: ${typeAnnotation.type}"`,
          );
      }
    case 'StringTypeAnnotation':
      return RCTBridgingTo('String');
    case 'NumberTypeAnnotation':
      return RCTBridgingTo('Double');
    case 'FloatTypeAnnotation':
      return RCTBridgingTo('Double');
    case 'Int32TypeAnnotation':
      return RCTBridgingTo('Double');
    case 'DoubleTypeAnnotation':
      return RCTBridgingTo('Double');
    case 'BooleanTypeAnnotation':
      return RCTBridgingTo('Bool');
    case 'GenericObjectTypeAnnotation':
      return value;
    case 'ArrayTypeAnnotation':
      const {elementType} = typeAnnotation;
      if (elementType == null) {
        return value;
      }

      const localVarName = `itemValue_${depth}`;
      const elementObjCType = toObjCType(codegenModuleName, elementType);
      const elementObjCValue = toObjCValue(
        codegenModuleName,
        elementType,
        localVarName,
        depth + 1,
      );

      return RCTBridgingTo(
        'Vec',
        `^${elementObjCType}(id ${localVarName}) { return ${elementObjCValue}; }`,
      );
    case 'TypeAliasTypeAnnotation':
      const structName = capitalize(typeAnnotation.name);
      const namespacedStructName = getNamespacedStructName(
        codegenModuleName,
        structName,
      );

      return !isRequired
        ? `(${value} == nil ? folly::none : folly::make_optional(${namespacedStructName}(${value})))`
        : `${namespacedStructName}(${value})`;
    default:
      (typeAnnotation.type: empty);
      throw new Error(
        `Couldn't convert into ObjC value: ${typeAnnotation.type}"`,
      );
  }
}

function serializeRegularStruct(
  codegenModuleName: string,
  struct: RegularStruct,
): StructSerilizationOutput {
  const declaration = StructTemplate({
    codegenModuleName: codegenModuleName,
    structName: struct.name,
    structProperties: struct.properties
      .map(property => {
        const {typeAnnotation, optional} = property;
        const propName = getSafePropertyName(property);
        const returnType = toObjCType(
          codegenModuleName,
          typeAnnotation,
          optional,
        );

        const padding = ' '.repeat(returnType.endsWith('*') ? 0 : 1);
        return `${returnType}${padding}${propName}() const;`;
      })
      .join('\n      '),
  });

  const methods = struct.properties
    .map<string>(property => {
      const {typeAnnotation, optional} = property;
      const propName = getSafePropertyName(property);
      const returnType = toObjCType(
        codegenModuleName,
        typeAnnotation,
        optional,
      );
      const returnValue = toObjCValue(
        codegenModuleName,
        typeAnnotation,
        'p',
        0,
        optional,
      );

      const padding = ' '.repeat(returnType.endsWith('*') ? 0 : 1);
      return MethodTemplate({
        codegenModuleName,
        structName: struct.name,
        returnType: returnType + padding,
        returnValue: returnValue,
        propertyName: propName,
      });
    })
    .join('\n');

  return {methods, declaration};
}

module.exports = {
  serializeRegularStruct,
};
