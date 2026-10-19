// 데이터베이스 드라이버 인터페이스와 방언별 읽기 전용 SQL 가드를 정의하는 모듈

export interface TableRef {
    schema: string;
    name: string;
    type: string;
}

export interface Column {
    name: string;
    type: string;
    nullable: boolean;
    maxLength: number | null;
    default: string | null;
    isPrimaryKey: boolean;
}

export interface QueryResult {
    columns: string[];
    rows: unknown[][];
    /** 실제로 반환한 행 수 */
    rowCount: number;
    /** 상한에 도달해 결과를 더 받지 않았는지. 전체 행 수는 알 수 없다. */
    truncated: boolean;
}

export interface Driver {
    listTables(): Promise<TableRef[]>;
    describeTable(schema: string, table: string): Promise<Column[]>;
    query(sql: string, params: Record<string, unknown>, maxRows: number): Promise<QueryResult>;
    close(): Promise<void>;
}

export type DialectName = 'mssql' | 'postgres' | 'mysql';

/** 방언별 렉싱 규칙과 가드 설정 */
interface DialectRules {
    /** 인용 식별자의 여는 문자와 닫는 문자. 같으면 겹쳐 쓰기 이스케이프를 지원한다. */
    identOpen: string;
    identClose: string;
    /** 블록 주석 중첩 허용 여부. T-SQL 과 PostgreSQL 만 중첩된다. */
    nestedBlockComments: boolean;
    /** `#` 한 줄 주석 (MySQL) */
    hashLineComments: boolean;
    /** 문자열 안 백슬래시 이스케이프 (MySQL 기본 동작) */
    backslashInStrings: boolean;
    /** `$tag$ ... $tag$` 달러 인용 문자열 (PostgreSQL) */
    dollarQuotedStrings: boolean;
    /** 읽기 전용 쿼리에서 금지하는 키워드 */
    forbidden: string[];
}

const DIALECTS: Record<DialectName, DialectRules> = {
    mssql: {
        identOpen: '[',
        identClose: ']',
        nestedBlockComments: true,
        hashLineComments: false,
        backslashInStrings: false,
        dollarQuotedStrings: false,
        /** 쓰기 또는 부수 효과를 일으킬 수 있는 키워드. */
        forbidden: [
            'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'DROP', 'CREATE', 'ALTER',
            'TRUNCATE', 'EXEC', 'EXECUTE', 'GRANT', 'REVOKE', 'INTO',
            'BACKUP', 'RESTORE', 'SHUTDOWN', 'RECONFIGURE', 'DBCC',
        ],
    },
    postgres: {
        identOpen: '"',
        identClose: '"',
        nestedBlockComments: true,
        hashLineComments: false,
        // standard_conforming_strings 기본값(on)을 따른다. E'...' 의 백슬래시는
        // 처리하지 않지만, 미처리 방향은 코드를 더 많이 검사하는 쪽이라 안전하다.
        backslashInStrings: false,
        dollarQuotedStrings: true,
        // 첫 토큰이 SELECT/WITH 로 제한되므로 여기서 실질적으로 중요한 것은
        // 데이터 수정 CTE(WITH x AS (INSERT ...))와 SELECT INTO 다. 나머지는
        // 최상위 전용 문장이지만 방어층으로 함께 둔다.
        forbidden: [
            'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'DROP', 'CREATE', 'ALTER',
            'TRUNCATE', 'GRANT', 'REVOKE', 'INTO', 'CALL', 'DO', 'COPY',
            'VACUUM', 'REINDEX', 'CLUSTER', 'REFRESH', 'LOCK', 'EXECUTE',
            'PREPARE', 'DEALLOCATE',
        ],
    },
    mysql: {
        identOpen: '`',
        identClose: '`',
        // MySQL 블록 주석은 중첩되지 않는다. 중첩으로 파싱하면
        // /* /* */ DELETE */ 의 DELETE 를 주석으로 오인해 가드가 뚫린다.
        nestedBlockComments: false,
        hashLineComments: true,
        backslashInStrings: true,
        dollarQuotedStrings: false,
        forbidden: [
            'INSERT', 'UPDATE', 'DELETE', 'DROP', 'CREATE', 'ALTER',
            'TRUNCATE', 'GRANT', 'REVOKE', 'INTO', 'CALL', 'DO', 'LOAD',
            'HANDLER', 'KILL',
        ],
    },
};

/** 금지 키워드를 `\b(A|B|...)\b` 하나로 묶는다. 호출마다 키워드 수만큼 RegExp 를 만들지 않기 위한 것이다. */
const FORBIDDEN_RE = Object.fromEntries(
    Object.entries(DIALECTS).map(([k, d]) => [k, new RegExp(`\\b(${d.forbidden.join('|')})\\b`)]),
) as Record<DialectName, RegExp>;

/** `--` (또는 mysql 의 `#`) 주석을 지나 줄 끝 인덱스를 돌려준다. */
function skipLineComment(sql: string, start: number): number {
    const nl = sql.indexOf('\n', start);
    return nl === -1 ? sql.length : nl;
}

/** 블록 주석을 지나 그 다음 인덱스를 돌려준다. */
function skipBlockComment(sql: string, start: number, nested: boolean): number {
    if (!nested) {
        const end = sql.indexOf('*/', start + 2);
        return end === -1 ? sql.length : end + 2;
    }
    let depth = 1;
    let i = start + 2;
    while (i < sql.length && depth > 0) {
        if (sql.slice(i, i + 2) === '/*') {
            depth++;
            i += 2;
        } else if (sql.slice(i, i + 2) === '*/') {
            depth--;
            i += 2;
        } else {
            i++;
        }
    }
    return i;
}

/** `'...'` 문자열을 지나 그 다음 인덱스를 돌려준다. `''` 와 방언별 `\'` 를 처리한다. */
function skipString(sql: string, start: number, d: DialectRules): number {
    let i = start + 1;
    while (i < sql.length) {
        if (d.backslashInStrings && sql[i] === '\\') {
            i += 2;
            continue;
        }
        if (sql[i] === "'") {
            // '' 는 이스케이프된 인용부호다.
            if (sql[i + 1] === "'") {
                i += 2;
                continue;
            }
            return i + 1;
        }
        i++;
    }
    return i;
}

/** 인용 식별자를 지나 그 다음 인덱스를 돌려준다. */
function skipQuotedIdent(sql: string, start: number, d: DialectRules): number {
    if (d.identOpen !== d.identClose) {
        // 대괄호형. T-SQL 은 첫 ] 에서 끝난다.
        const end = sql.indexOf(d.identClose, start + 1);
        return end === -1 ? sql.length : end + 1;
    }
    // "" / `` 겹쳐 쓰기 이스케이프를 지원한다.
    let i = start + 1;
    while (i < sql.length) {
        if (sql[i] === d.identClose) {
            if (sql[i + 1] === d.identClose) {
                i += 2;
                continue;
            }
            return i + 1;
        }
        i++;
    }
    return i;
}

/** `$tag$` 달러 인용의 닫는 태그 다음 인덱스를 돌려준다. 달러 인용이 아니면 null. */
function skipDollarQuote(sql: string, start: number): number | null {
    const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(start));
    if (!m) return null;
    const tag = m[0];
    const end = sql.indexOf(tag, start + tag.length);
    return end === -1 ? sql.length : end + tag.length;
}

/**
 * 주석과 문자열 리터럴을 제거한다.
 *
 * 주석을 지운 자리는 공백 하나로 바꿔서 `SEL/**\/ECT` 가 `SELECT` 로
 * 되살아나지 않게 한다. 문자열 리터럴은 내용이 검사를 오염시키지
 * 않도록 빈 리터럴로 바꾸고, 인용 식별자는 `x` 로 바꾼다.
 */
function stripNoise(sql: string, d: DialectRules): string {
    let out = '';
    let i = 0;

    while (i < sql.length) {
        const two = sql.slice(i, i + 2);

        if (two === '--' || (d.hashLineComments && sql[i] === '#')) {
            i = skipLineComment(sql, i);
            out += ' ';
            continue;
        }

        if (two === '/*') {
            i = skipBlockComment(sql, i, d.nestedBlockComments);
            out += ' ';
            continue;
        }

        const ch = sql[i]!;

        if (ch === "'") {
            i = skipString(sql, i, d);
            out += "''";
            continue;
        }

        if (d.dollarQuotedStrings && ch === '$') {
            const end = skipDollarQuote(sql, i);
            if (end !== null) {
                i = end;
                out += "''";
                continue;
            }
        }

        if (ch === d.identOpen) {
            i = skipQuotedIdent(sql, i, d);
            out += 'x';
            continue;
        }

        out += ch;
        i++;
    }

    return out;
}

/** 공통 전처리. mysql 실행 주석을 거부하고 노이즈를 제거해 돌려준다. */
function cleanForCheck(sql: string, dialect: DialectName): string {
    // MySQL 의 /*! ... */ 는 주석이 아니라 서버가 실행하는 코드다.
    // 주석으로 지우면 가드가 뚫리므로 파싱하지 않고 거부한다.
    if (dialect === 'mysql' && sql.includes('/*!')) {
        throw new Error('MySQL 실행 주석(/*! ... */)은 허용되지 않습니다.');
    }
    return stripNoise(sql, DIALECTS[dialect]).trim();
}

/**
 * 읽기 전용으로 보이지 않는 SQL 이면 예외를 던진다.
 *
 * 주의: 이것은 보안 경계가 아니다. LLM 의 실수를 막는 가드레일이다.
 * 실제 권한 통제는 읽기 전용 DB 계정으로 해야 한다.
 */
export function assertReadOnly(sql: string, dialect: DialectName): void {
    const cleaned = cleanForCheck(sql, dialect);

    if (!cleaned) {
        throw new Error('빈 쿼리입니다.');
    }

    // 끝의 세미콜론 하나는 허용하고, 그 뒤에 내용이 있으면 거부한다.
    const withoutTrailing = cleaned.replace(/;\s*$/, '');
    if (withoutTrailing.includes(';')) {
        throw new Error('여러 문장을 한 번에 실행할 수 없습니다. query 는 SELECT 한 문장만 받습니다.');
    }

    const upper = withoutTrailing.toUpperCase();

    const firstToken = upper.match(/^[A-Z]+/)?.[0];
    if (firstToken !== 'SELECT' && firstToken !== 'WITH') {
        throw new Error(
            `query 는 SELECT 또는 WITH 로 시작해야 합니다. 현재: ${firstToken ?? withoutTrailing.slice(0, 20)}.`,
        );
    }

    const kw = FORBIDDEN_RE[dialect].exec(upper)?.[1];
    if (kw) {
        throw new Error(`읽기 전용 쿼리에 ${kw} 를 쓸 수 없습니다.`);
    }
}

export interface BoundQuery {
    text: string;
    values: unknown[];
}

/**
 * `@이름` 파라미터를 위치 파라미터로 바꾼다.
 *
 * tool 인터페이스는 세 방언 모두 `@이름` 으로 통일했는데 pg 는 `$n`,
 * mysql 은 `?` 만 지원하므로 여기서 변환한다. 문자열/주석/인용 식별자
 * 안의 `@` 는 건드리지 않는다. `@@` 는 mysql 시스템 변수라 통과시킨다.
 * pg 의 `@>` `<@` 연산자는 `@` 뒤에 식별자가 붙지 않아 매칭되지 않는다.
 */
export function toPositionalParams(
    sql: string,
    params: Record<string, unknown>,
    dialect: 'postgres' | 'mysql',
): BoundQuery {
    const d = DIALECTS[dialect];
    let text = '';
    const values: unknown[] = [];
    // pg 는 같은 이름을 같은 $n 으로 재사용한다. mysql 의 ? 는 위치마다 값을 넣는다.
    const indexByName = new Map<string, number>();
    let i = 0;

    const copyTo = (end: number) => {
        text += sql.slice(i, end);
        i = end;
    };

    while (i < sql.length) {
        const two = sql.slice(i, i + 2);

        if (two === '--' || (d.hashLineComments && sql[i] === '#')) {
            copyTo(skipLineComment(sql, i));
            continue;
        }
        if (two === '/*') {
            copyTo(skipBlockComment(sql, i, d.nestedBlockComments));
            continue;
        }

        const ch = sql[i]!;

        if (ch === "'") {
            copyTo(skipString(sql, i, d));
            continue;
        }
        if (d.dollarQuotedStrings && ch === '$') {
            const end = skipDollarQuote(sql, i);
            if (end !== null) {
                copyTo(end);
                continue;
            }
        }
        if (ch === d.identOpen) {
            copyTo(skipQuotedIdent(sql, i, d));
            continue;
        }

        if (two === '@@') {
            text += '@@';
            i += 2;
            continue;
        }

        if (ch === '@') {
            const m = /^@([A-Za-z_][A-Za-z0-9_]*)/.exec(sql.slice(i));
            if (m) {
                const name = m[1]!;
                if (!(name in params)) {
                    throw new Error(`@${name} 에 해당하는 값이 params 에 없습니다.`);
                }
                if (dialect === 'postgres') {
                    let idx = indexByName.get(name);
                    if (idx === undefined) {
                        values.push(params[name]);
                        idx = values.length;
                        indexByName.set(name, idx);
                    }
                    text += `$${idx}`;
                } else {
                    values.push(params[name]);
                    text += '?';
                }
                i += m[0].length;
                continue;
            }
        }

        text += ch;
        i++;
    }

    return { text, values };
}
