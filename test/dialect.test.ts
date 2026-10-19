// PostgreSQL / MySQL 방언의 SQL 가드와 @이름 파라미터 변환을 검증하는 테스트

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertReadOnly, toPositionalParams } from '../src/driver.ts';

// --- PostgreSQL 읽기 전용 가드 ---

const pgAllowed = [
    'SELECT 1',
    'WITH recent AS (SELECT * FROM orders) SELECT * FROM recent',
    'SELECT * FROM users LIMIT 10',
    'SELECT "insert" FROM "delete"',
    // 달러 인용 문자열 안의 키워드는 실제 쓰기가 아니다.
    "SELECT $$DROP TABLE t$$ AS msg",
    "SELECT $tag$ ; DELETE FROM t $tag$ AS msg",
    // @> 는 containment 연산자다. 파라미터로 오인하면 안 된다.
    `SELECT * FROM t WHERE data @> '{"a":1}'`,
];

const pgRejected: Array<[string, string]> = [
    ['CALL do_stuff()', '프로시저 호출'],
    ["DO $$ BEGIN DELETE FROM t; END $$", 'DO 블록'],
    ["COPY t TO '/tmp/x'", 'COPY'],
    ['SELECT * INTO t2 FROM t', 'SELECT INTO'],
    ['WITH x AS (INSERT INTO t VALUES (1) RETURNING *) SELECT * FROM x', '데이터 수정 CTE'],
    ['SELECT 1; DROP TABLE t', '세미콜론 스태킹'],
    ['VACUUM', 'VACUUM'],
    ['REFRESH MATERIALIZED VIEW mv', 'REFRESH'],
];

for (const sql of pgAllowed) {
    test(`pg 허용: ${JSON.stringify(sql)}`, () => {
        assert.doesNotThrow(() => assertReadOnly(sql, 'postgres'));
    });
}

for (const [sql, why] of pgRejected) {
    test(`pg 거부(${why}): ${JSON.stringify(sql)}`, () => {
        assert.throws(() => assertReadOnly(sql, 'postgres'));
    });
}

test('pg 달러 인용이 닫히지 않으면 끝까지 문자열로 본다', () => {
    // 서버도 미종결 문자열로 거부하므로 가드는 통과시켜도 안전하다.
    assert.doesNotThrow(() => assertReadOnly('SELECT $$abc', 'postgres'));
});

// --- MySQL 읽기 전용 가드 ---

const myAllowed = [
    'SELECT 1',
    'SELECT `insert` FROM `delete`',
    'SELECT @@version',
    'SELECT 1 # 주석',
    // 백슬래시 이스케이프가 있는 문자열. 서버 기준으로 하나의 리터럴이다.
    "SELECT 'a\\'; DROP TABLE t' AS msg",
];

const myRejected: Array<[string, string]> = [
    ['CALL do_stuff()', '프로시저 호출'],
    ["LOAD DATA INFILE 'x' INTO TABLE t", 'LOAD DATA'],
    ["SELECT * FROM t INTO OUTFILE '/tmp/x'", 'INTO OUTFILE'],
    ['SELECT 1; DROP TABLE t', '세미콜론 스태킹'],
    // MySQL 은 블록 주석이 중첩되지 않는다. 첫 */ 에서 주석이 끝나므로
    // 뒤의 세미콜론 스태킹이 살아 있다.
    ['SELECT /* /* */ 1; DROP TABLE t', '비중첩 주석 뒤 스태킹'],
    ['SELECT /*! 1 */', '실행 주석'],
    ['DELETE FROM users', '직접 쓰기'],
    ['HANDLER t OPEN', 'HANDLER'],
];

for (const sql of myAllowed) {
    test(`mysql 허용: ${JSON.stringify(sql)}`, () => {
        assert.doesNotThrow(() => assertReadOnly(sql, 'mysql'));
    });
}

for (const [sql, why] of myRejected) {
    test(`mysql 거부(${why}): ${JSON.stringify(sql)}`, () => {
        assert.throws(() => assertReadOnly(sql, 'mysql'));
    });
}

// --- @이름 파라미터 변환 ---

test('pg 는 @이름 을 $n 으로 바꾸고 같은 이름을 재사용한다', () => {
    const b = toPositionalParams(
        'SELECT * FROM t WHERE id = @id AND name = @name AND id2 = @id',
        { id: 7, name: 'a' },
        'postgres',
    );
    assert.equal(b.text, 'SELECT * FROM t WHERE id = $1 AND name = $2 AND id2 = $1');
    assert.deepEqual(b.values, [7, 'a']);
});

test('mysql 은 @이름 을 ? 로 바꾸고 위치마다 값을 넣는다', () => {
    const b = toPositionalParams(
        'SELECT * FROM t WHERE id = @id OR parent = @id',
        { id: 7 },
        'mysql',
    );
    assert.equal(b.text, 'SELECT * FROM t WHERE id = ? OR parent = ?');
    assert.deepEqual(b.values, [7, 7]);
});

test('문자열/주석/인용 식별자 안의 @ 는 바꾸지 않는다', () => {
    const b = toPositionalParams(
        `SELECT '@notparam', "user@col" FROM t -- @comment\nWHERE id = @id`,
        { id: 1 },
        'postgres',
    );
    assert.equal(b.text, `SELECT '@notparam', "user@col" FROM t -- @comment\nWHERE id = $1`);
    assert.deepEqual(b.values, [1]);
});

test('mysql 의 @@시스템변수는 그대로 둔다', () => {
    const b = toPositionalParams('SELECT @@version, @id', { id: 1 }, 'mysql');
    assert.equal(b.text, 'SELECT @@version, ?');
    assert.deepEqual(b.values, [1]);
});

test('pg 의 @> 연산자는 파라미터로 오인하지 않는다', () => {
    const b = toPositionalParams(
        `SELECT * FROM t WHERE data @> '{"a":1}' AND id = @id`,
        { id: 1 },
        'postgres',
    );
    assert.equal(b.text, `SELECT * FROM t WHERE data @> '{"a":1}' AND id = $1`);
    assert.deepEqual(b.values, [1]);
});

test('params 에 없는 @이름 은 에러다', () => {
    assert.throws(
        () => toPositionalParams('SELECT @missing', {}, 'postgres'),
        /@missing 에 해당하는 값이 params 에 없습니다/,
    );
});

test('사용하지 않은 params 키는 무시한다', () => {
    // mssql 드라이버도 선언만 하고 안 쓰는 파라미터를 허용한다. 동작을 맞춘다.
    const b = toPositionalParams('SELECT @id', { id: 1, unused: 2 }, 'postgres');
    assert.deepEqual(b.values, [1]);
});
