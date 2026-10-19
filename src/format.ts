// 쿼리 결과를 LLM 이 읽기 쉬운 텍스트로 렌더링하는 모듈

import type { Column, QueryResult, TableRef } from './driver.ts';

/**
 * 값 하나를 텍스트로 변환한다.
 *
 * 출력이 텍스트라서 JSON.stringify 의 직렬화 문제를 대부분 우회한다.
 * BIGINT 는 tedious 가 이미 문자열로 넘겨주므로 bigint 분기는 방어용이다.
 */
export function cell(v: unknown): string {
    if (v === null || v === undefined) return 'NULL';
    if (v instanceof Date) return v.toISOString();
    if (Buffer.isBuffer(v)) return `0x${v.toString('hex')}`;
    if (typeof v === 'bigint') return v.toString();
    if (typeof v === 'object') return escape(JSON.stringify(v));
    return escape(String(v));
}

/** 표 구분자와 줄바꿈이 행 구조를 깨뜨리지 않게 치환한다. */
function escape(s: string): string {
    return s.replace(/\|/g, '\\|').replace(/\r?\n/g, '\\n');
}

const nf = new Intl.NumberFormat('en-US');

/** 쿼리 결과를 헤더 + 파이프 구분 행으로 렌더링한다. */
export function formatQueryResult(r: QueryResult): string {
    const notes: string[] = [];

    if (r.truncated) {
        notes.push(
            `${nf.format(r.rowCount)}행 표시. 상한에 도달해 결과가 더 있습니다 (잘림). ` +
                'TOP/LIMIT 이나 WHERE 로 범위를 좁히세요.',
        );
    } else {
        notes.push(`${nf.format(r.rowCount)}행.`);
    }

    if (r.rowCount === 0) {
        return ['(행 없음)', '', ...notes].join('\n');
    }

    const lines = [
        r.columns.join(' | '),
        ...r.rows.map((row) => row.map(cell).join(' | ')),
    ];

    return [...lines, '', ...notes].join('\n');
}

/** 테이블 목록을 스키마별로 묶어 렌더링한다. */
export function formatTableList(tables: TableRef[]): string {
    if (tables.length === 0) return '테이블이 없습니다.';

    const lines = ['schema | name | type'];
    for (const t of tables) {
        lines.push([t.schema, t.name, t.type].map(cell).join(' | '));
    }
    lines.push('', `${nf.format(tables.length)}개.`);
    return lines.join('\n');
}

/** 컬럼 정보를 렌더링한다. */
export function formatColumns(schema: string, table: string, columns: Column[]): string {
    if (columns.length === 0) {
        return `${schema}.${table} 을 찾을 수 없거나 컬럼이 없습니다.`;
    }

    const lines = [`${schema}.${table}`, '', 'column | type | nullable | default | key'];
    for (const c of columns) {
        const type = c.maxLength !== null ? `${c.type}(${c.maxLength === -1 ? 'max' : c.maxLength})` : c.type;
        lines.push(
            [
                cell(c.name),
                cell(type),
                c.nullable ? 'NULL' : 'NOT NULL',
                c.default === null ? '-' : cell(c.default),
                c.isPrimaryKey ? 'PK' : '',
            ].join(' | '),
        );
    }
    lines.push('', `${nf.format(columns.length)}개 컬럼.`);
    return lines.join('\n');
}
