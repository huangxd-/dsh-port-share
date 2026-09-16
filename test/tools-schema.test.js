// 工具定义 schema 合规性测试：校验 buildToolDefs 产出的原始 ToolDefinition
// 符合 dsh-tools 强制 JSON-Schema 子集（packages/core/tools/src/json-schema.ts），
// 并验证一个样例返回值能通过输出 schema 校验——防止模型工具注册时被宿主拒绝。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildToolDefs } from '../lib/index.js';

const SCHEMA_TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'];
const CONSTRAINT_KEYWORDS = ['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const'];
const ANNOTATION_KEYWORDS = ['description', 'title', 'default', 'examples'];
const SCALAR_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'null']);

/** 校验一个 schema 节点符合强制子集（仅检查结构，不检查语义注解）。 */
function assertSchemaNode(node, path) {
  assert.ok(node && typeof node === 'object', `${path}: schema 节点必须是对象`);
  const keys = Object.keys(node);
  for (const k of keys) {
    assert.ok(
      CONSTRAINT_KEYWORDS.includes(k) || ANNOTATION_KEYWORDS.includes(k),
      `${path}.${k}: 非法关键字（子集外）`,
    );
  }
  if ('type' in node) {
    assert.ok(SCHEMA_TYPES.includes(node.type), `${path}.type: 非法类型 ${node.type}`);
  }
  if ('oneOf' in node) {
    assert.ok(Array.isArray(node.oneOf) && node.oneOf.length >= 2, `${path}.oneOf: 至少两个分支`);
    node.oneOf.forEach((c, i) => assertSchemaNode(c, `${path}.oneOf[${i}]`));
  }
  if ('properties' in node) {
    assert.equal(node.type, 'object', `${path}.properties 仅用于 object`);
    assert.ok(node.properties && typeof node.properties === 'object' && !Array.isArray(node.properties), `${path}.properties 必须是对象`);
    for (const [k, child] of Object.entries(node.properties)) assertSchemaNode(child, `${path}.properties.${k}`);
  }
  if ('required' in node) {
    assert.ok(Array.isArray(node.required), `${path}.required 必须是数组`);
    for (const r of node.required) {
      assert.equal(typeof r, 'string', `${path}.required[${r}] 必须是字符串`);
      assert.ok(node.properties && r in node.properties, `${path}.required 引用了不存在的属性 ${r}`);
    }
  }
  if ('additionalProperties' in node) assert.equal(typeof node.additionalProperties, 'boolean', `${path}.additionalProperties 必须是布尔`);
  if ('items' in node) {
    assert.equal(node.type, 'array', `${path}.items 仅用于 array`);
    assertSchemaNode(node.items, `${path}.items`);
  }
  if ('enum' in node) {
    assert.ok(SCALAR_TYPES.has(node.type), `${path}.enum 仅用于标量类型`);
    assert.ok(Array.isArray(node.enum), `${path}.enum 必须是数组`);
    for (const v of node.enum) {
      const t = typeof v;
      assert.ok((node.type === 'integer' && Number.isInteger(v)) || (node.type === 'null' && v === null) || (node.type !== 'null' && node.type !== 'integer' && t === node.type), `${path}.enum 值与 type 不符`);
    }
  }
  if ('const' in node) assert.ok(SCALAR_TYPES.has(node.type), `${path}.const 仅用于标量类型`);
}

/** 按子集规则校验一个值是否符合 schema。 */
function checkValue(schema, value, path) {
  if ('oneOf' in schema) {
    const any = schema.oneOf.some((c) => checkValue(c, value, path));
    if (!any) return `${path}: 不匹配任何 oneOf 分支`;
    return null;
  }
  const type = schema.type ?? (value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value);
  const t = typeof value;
  if (type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return `${path}: 期望 object`;
    if (schema.additionalProperties === false && schema.properties) {
      for (const k of Object.keys(value)) if (!(k in schema.properties)) return `${path}.${k}: 未声明的属性`;
    }
    for (const [k, v] of Object.entries(value ?? {})) {
      if (schema.properties && k in schema.properties) {
        const e = checkValue(schema.properties[k], v, `${path}.${k}`);
        if (e) return e;
      } else if (schema.additionalProperties === false) {
        return `${path}.${k}: 未声明属性`;
      }
    }
    return null;
  }
  if (type === 'array') {
    if (!Array.isArray(value)) return `${path}: 期望 array`;
    if (schema.items) for (let i = 0; i < value.length; i++) { const e = checkValue(schema.items, value[i], `${path}[${i}]`); if (e) return e; }
    return null;
  }
  const matchesType = (type === 'integer' && Number.isInteger(value)) || (type === 'null' && value === null) || (type !== 'integer' && type !== 'null' && t === type);
  if (!matchesType) return `${path}: 期望 ${type}，实际 ${value === null ? 'null' : t}`;
  if (schema.enum && !schema.enum.some((v) => Object.is(v, value))) return `${path}: 不在 enum 中`;
  if ('const' in schema && !Object.is(schema.const, value)) return `${path}: 不等于 const`;
  return null;
}

// 样例返回值（manager.status 的真实形状）
const SAMPLE_RECORD = {
  id: 'uuid-1',
  port: 3000,
  host: '127.0.0.1',
  name: 'demo',
  lan: true,
  public: false,
  publicPort: null,
  mode: 'proxy',
  lanPort: 3001,
  tunnelUrl: 'https://abc.trycloudflare.com',
  targetReachable: true,
  error: null,
  tunnelError: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  lanIp: '192.168.1.5',
  lanUrl: 'http://192.168.1.5:3001',
  proxyRunning: true,
  tunnelRunning: false,
  tunnelPhase: null,
};

test('工具定义：schema 全部符合强制子集，required 为根级数组', () => {
  const defs = buildToolDefs({});
  assert.equal(defs.length, 5);
  const names = new Set(defs.map((d) => d.name));
  assert.deepEqual(
    [...names].sort(),
    ['port_share_add', 'port_share_list', 'port_share_remove', 'port_share_status', 'port_share_update'],
  );
  for (const def of defs) {
    assert.ok(def.description?.length > 0, `${def.name}: 应有描述`);
    assert.ok(typeof def.execute === 'function', `${def.name}: 应有 execute`);
    assert.ok(def.output && typeof def.output.render === 'function', `${def.name}: 应有 output.render`);
    assertSchemaNode(def.parameters, `${def.name}.parameters`);
    assertSchemaNode(def.output.schema, `${def.name}.output.schema`);
    // 必填参数必须在根级 required 数组里
    for (const [k, spec] of Object.entries(def.parameters.properties ?? {})) {
      if (spec.required === true) assert.fail(`${def.name}: 属性 ${k} 里残留 required 布尔标记`);
    }
  }
  // add/status/update/remove 都要求 port
  for (const n of ['port_share_add', 'port_share_status', 'port_share_update', 'port_share_remove']) {
    const def = defs.find((d) => d.name === n);
    assert.ok(def.parameters.required.includes('port'), `${n}: port 必须是必填参数`);
  }
});

test('工具定义：样例返回值通过各工具输出 schema', () => {
  const defs = buildToolDefs({});
  for (const def of defs) {
    let value;
    if (def.name === 'port_share_list') value = [SAMPLE_RECORD, SAMPLE_RECORD];
    else if (def.name === 'port_share_remove') value = { removed: true, port: 3000 };
    else value = SAMPLE_RECORD;
    const err = checkValue(def.output.schema, value, def.name);
    assert.equal(err, null, `${def.name}: 输出校验失败 — ${err}`);
    // render 必须产出 ContentBlock 形状
    const blocks = def.output.render({}, value);
    assert.ok(Array.isArray(blocks) && blocks.every((b) => b.type === 'text' && typeof b.text === 'string'), `${def.name}: render 应返回 text 块`);
  }
});
