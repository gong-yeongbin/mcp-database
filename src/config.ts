// DATABASE_URL 등 환경변수를 파싱해 방언별 접속 설정으로 변환하는 모듈

import type { config as MssqlConfig } from 'mssql';
import type { PoolConfig as PgPoolConfig } from 'pg';
import type { PoolOptions as MysqlPoolOptions } from 'mysql2';

interface Common {
    /** describe 계열 tool 의 기본 스키마. mssql=dbo, postgres=public, mysql=접속 DB */
    defaultSchema: string;
    /** 시작 로그에 쓰는 host:port/database 표기 */
    label: string;
}

export type DbConfig = Common &
    (
        | { kind: 'mssql'; db: MssqlConfig }
        | { kind: 'postgres'; db: PgPoolConfig }
        | { kind: 'mysql'; db: MysqlPoolOptions }
    );

export type Config = DbConfig & { maxRows: number };

const DEFAULT_MAX_ROWS = 1000;

const DEFAULT_PORTS = { mssql: 1433, postgres: 5432, mysql: 3306 } as const;

/**
 * `mssql://user:pass@host:1433/dbname` 형태의 URL 을 파싱한다.
 * 스킴이 드라이버를 결정한다. mssql / postgres(postgresql) / mysql.
 *
 * mssql 패키지의 parseConnectionString 은 ADO.NET 문법만 이해하고,
 * URL 을 넘기면 에러 없이 빈 설정을 돌려주기 때문에 직접 파싱한다.
 */
export function parseDatabaseUrl(raw: string): DbConfig {
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        throw new Error(`DATABASE_URL 형식이 올바르지 않습니다: ${raw}`);
    }

    const kind = {
        'mssql:': 'mssql',
        'postgres:': 'postgres',
        'postgresql:': 'postgres',
        'mysql:': 'mysql',
    }[url.protocol] as 'mssql' | 'postgres' | 'mysql' | undefined;

    if (!kind) {
        throw new Error(
            `지원하지 않는 DATABASE_URL 스킴입니다: ${url.protocol}// ` +
                '(mssql:// postgres:// postgresql:// mysql:// 중 하나여야 합니다)',
        );
    }
    if (!url.hostname) {
        throw new Error('DATABASE_URL 에 호스트가 없습니다.');
    }

    const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
    if (!database) {
        throw new Error(`DATABASE_URL 에 데이터베이스 이름이 없습니다. 예: ${kind}://user:pass@host/mydb`);
    }
    if (!url.username) {
        throw new Error('DATABASE_URL 에 사용자 이름이 없습니다.');
    }

    // 비밀번호에 @ ; / 같은 문자가 흔해서 URL 인코딩된 값이 들어온다.
    const user = decodeURIComponent(url.username);
    const password = decodeURIComponent(url.password);

    const host = url.hostname;
    const port = url.port ? Number(url.port) : DEFAULT_PORTS[kind];
    const q = url.searchParams;
    const label = `${host}:${port}/${database}`;

    if (kind === 'mssql') {
        return {
            kind,
            defaultSchema: 'dbo',
            label,
            db: {
                server: host,
                port,
                database,
                user,
                password,
                options: {
                    encrypt: q.get('encrypt') !== 'false',
                    trustServerCertificate: q.get('trustServerCertificate') !== 'false',
                },
                // stdio 서버는 호출자 하나를 순차 처리하므로 커넥션을 많이 열 필요가 없다.
                pool: { max: 2, min: 0, idleTimeoutMillis: 30_000 },
                // 폭주 쿼리가 서버를 붙잡지 않고 깨끗하게 실패하도록 한다.
                requestTimeout: 30_000,
            },
        };
    }

    // pg/mysql 의 ssl 은 기본 꺼짐. ssl=true 면 인증서 검증 없이 켠다.
    // mssql 의 trustServerCertificate 기본값과 같은 수준이다.
    const ssl = q.get('ssl') === 'true' ? { rejectUnauthorized: false } : undefined;

    if (kind === 'postgres') {
        return {
            kind,
            defaultSchema: 'public',
            label,
            db: {
                host,
                port,
                database,
                user,
                password,
                ssl,
                max: 2,
                idleTimeoutMillis: 30_000,
                statement_timeout: 30_000,
                // 기본값 0 은 무한 대기다. 호스트가 죽어 있으면 OS TCP 타임아웃까지 멈춘다.
                connectionTimeoutMillis: 15_000,
            },
        };
    }

    return {
        kind,
        // MySQL 은 schema 와 database 가 같은 개념이다.
        defaultSchema: database,
        label,
        db: {
            host,
            port,
            database,
            user,
            password,
            ssl,
            connectionLimit: 2,
        },
    };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
    const raw = env.DATABASE_URL;
    if (!raw) {
        throw new Error('DATABASE_URL 환경변수가 필요합니다. 예: mssql://user:pass@host:1433/mydb');
    }

    let maxRows = DEFAULT_MAX_ROWS;
    if (env.MAX_ROWS !== undefined) {
        const parsed = Number(env.MAX_ROWS);
        if (!Number.isInteger(parsed) || parsed < 1) {
            throw new Error(`MAX_ROWS 는 1 이상의 정수여야 합니다. 현재: ${env.MAX_ROWS}`);
        }
        maxRows = parsed;
    }

    return { ...parseDatabaseUrl(raw), maxRows };
}
