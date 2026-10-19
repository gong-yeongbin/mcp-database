// 값 변환과 결과 렌더링, 행 상한 문구를 검증하는 테스트

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cell, formatQueryResult, formatTableList, formatColumns } from '../src/format.ts';
import type { QueryResult } from '../src/driver.ts';

test('cell: null 과 undefined 는 NULL 이다', () => {
    assert.equal(cell(null), 'NULL');
    assert.equal(cell(undefined), 'NULL');
});

test('cell: Date 는 ISO 문자열이다', () => {
    assert.equal(cell(new Date('2024-01-15T10:30:00.000Z')), '2024-01-15T10:30:00.000Z');
});

test('cell: Buffer 는 0x hex 다', () => {
    assert.equal(cell(Buffer.from([0xde, 0xad, 0xbe, 0xef])), '0xdeadbeef');
});

test('cell: bigint 는 문자열이다', () => {
    assert.equal(cell(10n ** 20n), '100000000000000000000');
});

test('cell: 숫자와 불리언', () => {
    assert.equal(cell(0), '0');
    assert.equal(cell(-1.5), '-1.5');
    assert.equal(cell(false), 'false');
    assert.equal(cell(true), 'true');
});

test('cell: 객체는 JSON 이다', () => {
    assert.equal(cell({ a: 1 }), '{"a":1}');
});

test('cell: 파이프와 줄바꿈을 이스케이프한다', () => {
    assert.equal(cell('a|b'), 'a\\|b');
    assert.equal(cell('a\nb'), 'a\\nb');
    assert.equal(cell('a\r\nb'), 'a\\nb');
});

function result(over: Partial<QueryResult> = {}): QueryResult {
    return {
        columns: ['id', 'name'],
        rows: [[1, 'Alice'], [2, 'Bob']],
        rowCount: 2,
        truncated: false,
        ...over,
    };
}

test('결과를 헤더 + 파이프 구분 행으로 렌더링한다', () => {
    const out = formatQueryResult(result());
    assert.match(out, /^id \| name\n1 \| Alice\n2 \| Bob\n\n2행\.$/);
});

test('행이 없으면 명시한다', () => {
    const out = formatQueryResult(result({ rows: [], rowCount: 0 }));
    assert.match(out, /\(행 없음\)/);
    assert.match(out, /0행\./);
});

test('잘리지 않으면 잘림 안내가 없다', () => {
    const out = formatQueryResult(result({ rowCount: 1000, rows: [[1, 'a']] }));
    assert.doesNotMatch(out, /잘림/);
    assert.match(out, /1,000행\./);
});

test('잘리면 반환 행 수와 결과가 더 있다는 사실을 알린다', () => {
    const out = formatQueryResult(result({ rowCount: 1000, truncated: true, rows: [[1, 'a']] }));
    assert.match(out, /1,000행 표시\. 상한에 도달해 결과가 더 있습니다 \(잘림\)/);
    assert.match(out, /TOP\/LIMIT 이나 WHERE/);
});

test('상한 경계 999 / 1000 / 1001', () => {
    // 999행: 상한 1000 미달이므로 잘리지 않는다.
    const under = formatQueryResult(result({ rowCount: 999, rows: [[1, 'a']] }));
    assert.doesNotMatch(under, /잘림/);
    assert.match(under, /999행\./);

    // 정확히 1000행: 드라이버가 1001번째 행을 받지 못했으므로 잘리지 않는다.
    const exact = formatQueryResult(result({ rowCount: 1000, rows: [[1, 'a']] }));
    assert.doesNotMatch(exact, /잘림/);

    // 1001번째 행이 왔고 1000행만 반환: 잘림.
    const over = formatQueryResult(result({ rowCount: 1000, truncated: true, rows: [[1, 'a']] }));
    assert.match(over, /1,000행 표시/);
    assert.match(over, /잘림/);
});

test('테이블 목록을 렌더링한다', () => {
    const out = formatTableList([
        { schema: 'dbo', name: 'users', type: 'BASE TABLE' },
        { schema: 'dbo', name: 'v_active', type: 'VIEW' },
    ]);
    assert.match(out, /schema \| name \| type/);
    assert.match(out, /dbo \| users \| BASE TABLE/);
    assert.match(out, /dbo \| v_active \| VIEW/);
    assert.match(out, /2개\./);
});

test('테이블이 없으면 명시한다', () => {
    assert.match(formatTableList([]), /테이블이 없습니다/);
});

test('컬럼 정보를 렌더링한다', () => {
    const out = formatColumns('dbo', 'users', [
        { name: 'id', type: 'int', nullable: false, maxLength: null, default: null, isPrimaryKey: true },
        { name: 'name', type: 'varchar', nullable: true, maxLength: 50, default: "('')", isPrimaryKey: false },
        { name: 'bio', type: 'nvarchar', nullable: true, maxLength: -1, default: null, isPrimaryKey: false },
    ]);
    assert.match(out, /^dbo\.users/);
    assert.match(out, /id \| int \| NOT NULL \| - \| PK/);
    assert.match(out, /name \| varchar\(50\) \| NULL \| \(''\) \|/);
    // maxLength -1 은 MAX 를 뜻한다.
    assert.match(out, /bio \| nvarchar\(max\)/);
    assert.match(out, /3개 컬럼\./);
});

test('컬럼이 없으면 테이블을 못 찾았다고 알린다', () => {
    assert.match(formatColumns('dbo', 'nope', []), /dbo\.nope 을 찾을 수 없거나/);
});
