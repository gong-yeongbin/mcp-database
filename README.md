[![M8ven 라이브 인증](https://m8ven.ai/badge/mcp/gong-yeongbin-mcp-database-1oat62)](https://m8ven.ai/mcp/gong-yeongbin-mcp-database-1oat62)
# @dudqls816/database-mcp

SQL Server / PostgreSQL / MySQL 을 조회하는 MCP 서버. LLM 이 스키마를 탐색하고 쿼리를 실행할 수 있게 한다. `DATABASE_URL` 의 스킴(`mssql://` `postgres://` `mysql://`)이 드라이버를 결정한다.

**`SELECT` 조회만 한다.** 임의 SQL 을 실행하는 tool 은 없고, 서버의 쓰기 가드는 보조
장치다. 실제 통제는 [읽기 전용 DB 계정](#빠른-시작)이다.

## 목차

**쓰기 시작하려면** — [빠른 시작](#빠른-시작) · [업데이트](#업데이트) · [환경변수](#환경변수) · [Tool](#tool) · [스코프와 저장 위치](#스코프와-저장-위치)

**보안을 검토하려면** — [무엇이 실제로 통제되는가](#보안-무엇이-실제로-통제되는가) · [우회 가능한 경로](#우회-가능한-경로) · [DB 권한으로 좁히기](#db-권한으로-좁히기)

**운영 중 걸리는 것** — [알아둘 것](#알아둘-것)

## 빠른 시작

**1. 읽기 전용 계정을 만든다.** 이것이 유일하게 우회 불가능한 통제다. 서버의 쓰기 가드를
포함한 나머지 장치는 전부 우회할 수 있다.

SQL Server.

```sql
CREATE LOGIN mcp_ro WITH PASSWORD = 'Str0ng!Passw0rd';
USE mydb;
CREATE USER mcp_ro FOR LOGIN mcp_ro;
ALTER ROLE db_datareader ADD MEMBER mcp_ro;
```

PostgreSQL.

```sql
CREATE ROLE mcp_ro LOGIN PASSWORD 'Str0ng!Passw0rd';
GRANT CONNECT ON DATABASE mydb TO mcp_ro;
GRANT USAGE ON SCHEMA public TO mcp_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO mcp_ro;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO mcp_ro;
```

MySQL.

```sql
CREATE USER 'mcp_ro'@'%' IDENTIFIED BY 'Str0ng!Passw0rd';
GRANT SELECT ON mydb.* TO 'mcp_ro'@'%';
```

권한을 더 좁히는 방법은 [DB 권한으로 좁히기](#db-권한으로-좁히기)에 있다.

**2. 서버를 등록한다.** 설치는 따로 하지 않는다. `npx` 가 패키지를 받아 실행한다.

CLI 로 등록하는 방법과 설정 파일을 직접 쓰는 방법이 있다. **결과는 같다** —
`claude mcp add` 는 아래 JSON 을 설정 파일에 써 넣는 편의 명령일 뿐이다.

**방법 A. CLI**

```bash
claude mcp add dudqls816-database -s local \
  -e DATABASE_URL='mssql://mcp_ro:Str0ng%21Passw0rd@localhost:1433/mydb' \
  -- npx -y @dudqls816/database-mcp
```

**방법 B. 설정 파일 직접 작성**

프로젝트 루트에 `.mcp.json` 을 만든다.

```json
{
  "mcpServers": {
    "dudqls816-database": {
      "command": "npx",
      "args": ["-y", "@dudqls816/database-mcp"],
      "env": {
        "DATABASE_URL": "mssql://mcp_ro:Str0ng%21Passw0rd@localhost:1433/mydb"
      }
    }
  }
}
```

`.mcp.json` 은 처음 열 때 승인 프롬프트가 뜨고, 승인 전에는 `claude mcp get` 에서
`⏸ Pending approval` 로 표시된다. 승인 없이 쓰려면 `~/.claude.json` 의
`projects["<프로젝트경로>"].mcpServers` 에 같은 내용을 넣는다(`-s local` 과 동일).

전역 설치를 선호하면 `npx` 대신 명령을 직접 쓴다.

```bash
npm i -g @dudqls816/database-mcp
claude mcp add dudqls816-database -s local \
  -e DATABASE_URL='mssql://mcp_ro:pw@localhost:1433/mydb' \
  -- dudqls816-database-mcp
```

**3. 확인한다.**

```bash
claude mcp get dudqls816-database    # ✔ Connected
```

DB 가 꺼져 있어도 `Connected` 로 나온다. 연결은 첫 tool 호출 때 이루어지므로 정상이다.

이제 "테이블 목록 보여줘", "users 테이블 구조", "최근 주문 10건" 처럼 요청하면 된다.
임의 SQL 을 실행하는 tool 은 애초에 존재하지 않는다.

## 업데이트

등록 방식에 따라 다르다.

| 방식 | 최신 버전 반영 |
| --- | --- |
| `npx` (방법 A, B) | 자동. 단 캐시가 남아 있는 동안은 이전 버전을 쓴다 |
| 전역 설치 | 수동. 직접 업데이트해야 한다 |

`npx` 는 받은 패키지를 캐시에 두고 재사용하므로 새 버전이 즉시 반영되지는 않는다.
바로 받으려면 `@latest` 를 붙여 실행한다.

```bash
npx -y @dudqls816/database-mcp@latest
```

전역 설치로 쓴다면 직접 올린다.

```bash
npm update -g @dudqls816/database-mcp
```

현재 배포된 버전과 설치된 버전은 이렇게 확인한다.

```bash
npm view @dudqls816/database-mcp version   # registry 의 최신 버전
npm ls -g @dudqls816/database-mcp          # 전역 설치된 버전
```

**Major 버전은 자동으로 넘어오지 않는다.** `npx` 는 `^0.1.0` 처럼 호환 범위로 캐시하므로
`0.x` 안에서는 알아서 올라가지만 `1.0.0` 은 그 범위 밖이다. Major 가 올라가면 tool 이름이나
설정이 바뀌었을 수 있으니, 릴리스 노트를 확인하고 위 `@latest` 명령으로 명시적으로 받는다.

## 환경변수

| 변수 | 필수 | 기본값 | 설명 |
| --- | --- | --- | --- |
| `DATABASE_URL` | O | — | 아래 스킴 중 하나 |
| `MAX_ROWS` | X | `1000` | `query` 가 반환할 최대 행 수 |

```
mssql://user:password@host:1433/database
postgres://user:password@host:5432/database    (postgresql:// 도 동일)
mysql://user:password@host:3306/database
```

포트를 생략하면 방언별 기본 포트(1433 / 5432 / 3306)를 쓴다. 특수문자는 URL 인코딩한다.
비밀번호에 `@` `:` `/` 가 흔하다.

```
Str0ng!P@ss  ->  mssql://sa:Str0ng%21P%40ss@localhost:1433/mydb
```

TLS 옵션은 query string 으로 조절한다.

```
mssql://sa:pw@localhost:1433/mydb?encrypt=false&trustServerCertificate=false   # 둘 다 기본 true
postgres://app:pw@host:5432/mydb?ssl=true    # pg/mysql 은 기본 꺼짐. 켜면 인증서 검증 없이 연결
```

## Tool

조회 tool 3개를 제공한다.

| Tool | 설명 |
| --- | --- |
| `list_tables` | 모든 테이블과 뷰를 스키마와 함께 나열 |
| `describe_table` | 컬럼, 자료형, NULL 허용, 기본값, 기본키 |
| `query` | `SELECT` 한 문장 실행 |

`query` 는 세 방언 모두 `@이름` 파라미터를 지원한다. PostgreSQL 은 `$n`, MySQL 은 `?` 로
서버가 내부에서 변환하므로 호출자는 방언을 신경 쓰지 않아도 된다.

```json
{
  "sql": "SELECT * FROM orders WHERE customer_id = @cid AND status = @st",
  "params": { "cid": 42, "st": "paid" }
}
```

파라미터는 값만 바인딩한다. 테이블명과 컬럼명은 파라미터로 바꿀 수 없다.

## 스코프와 저장 위치

`-s` 값에 따라 설정이 저장되는 곳이 다르다. `.mcp.json` 은 `-s project` 일 때만 생긴다.

| 스코프 | 저장 위치 | 범위 |
| --- | --- | --- |
| `-s local` (기본값) | `~/.claude.json` 의 `projects["<경로>"].mcpServers` | 이 프로젝트, 나만 |
| `-s user` | `~/.claude.json` 최상위 | 내 모든 프로젝트 |
| `-s project` | `<프로젝트루트>/.mcp.json` | git 에 커밋되어 팀 공유 |

> **`-s project` 주의**: `.mcp.json` 은 저장소에 커밋되고 `env` 의 비밀번호가 평문으로 들어간다.
> 혼자 쓴다면 `-s local` 또는 `-s user` 를 쓴다.

```bash
claude mcp get dudqls816-database
claude mcp list
claude mcp remove dudqls816-database -s local
```

### Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json` 에 직접 쓴다.
`.mcp.json` 을 손으로 쓸 때도 같은 형식이다.

```json
{
  "mcpServers": {
    "dudqls816-database": {
      "command": "npx",
      "args": ["-y", "@dudqls816/database-mcp"],
      "env": {
        "DATABASE_URL": "mssql://mcp_ro:pw@localhost:1433/mydb"
      }
    }
  }
}
```

## 보안: 무엇이 실제로 통제되는가

**쓰기 차단은 편의 기능이고, 실제 통제는 DB 계정이다.**

임의 SQL 을 실행하는 tool 은 등록 자체가 되지 않는다. `query` 는 여러 문장,
`SELECT`/`WITH` 로 시작하지 않는 문장, 쓰기 키워드를 방언별 규칙으로 거부한다. 다만 문자열
검사로 SQL 의 모든 부수 효과를 막을 수는 없다. **이 가드는 LLM 의 실수를 막는 장치이고 보안 경계가 아니다.**

Claude Code 의 `permissions` 설정으로 tool 호출을 추가로 막을 수도 있으나, 그것은 Claude 가
이 서버를 통해 부르는 호출만 막는 편의 층이다. 이 문서는 우회가 불가능한 DB 계정 권한만 다룬다.

### 우회 가능한 경로

서버의 가드는 **이 MCP 서버를 통한 호출만** 거친다. 접속 문자열을 읽을 수
있는 프로세스는 그 계정 권한 전부를 행사할 수 있다. 그리고 서버를 통한 호출 중에도
가드를 빠져나가는 경로가 있다(4번).

**1. 셸에서 직접 접속**
접속 문자열만 있으면 아무 클라이언트로나 붙을 수 있다. `sqlcmd`, DBeaver, TablePlus,
또는 스크립트 몇 줄이면 된다.

```bash
sqlcmd -S localhost,1433 -U sa -P pw -Q "DELETE FROM users"
```

**2. 서버를 다른 계정으로 직접 실행**
`DATABASE_URL` 에 권한이 더 넓은 계정을 넣어 서버를 띄우면 그 계정의 권한이 그대로 열린다.
`claude mcp remove` 후 다른 `DATABASE_URL` 로 재등록해도 같다.

```bash
DATABASE_URL='mssql://sa:pw@localhost:1433/mydb' npx @dudqls816/database-mcp
```

**3. 접속 정보 노출**
`DATABASE_URL` 은 `~/.claude.json` 에 평문으로 저장된다. `-s project` 로 등록했다면
`.mcp.json` 이 git 에 커밋되어 저장소 접근자 전원이 볼 수 있다.

여기까지는 서버 **바깥에서** 우회하는 경로다. 아래는 서버를 정상적으로 쓰면서
읽기 전용 전제를 벗어나는 경로다.

**4. `query` 의 키워드 검사는 문자열 매칭이다.**
`assertReadOnly` 는 주석과 문자열 리터럴을 제거한 뒤 `SELECT` 또는 `WITH` 로 시작하는지 보고
쓰기 키워드가 있는지 본다. 이 검사를 통과하면서 읽기 범위를 벗어나는 SQL 이 존재한다.
아래는 모두 현재 가드를 **통과한다**.

```sql
SELECT * FROM OPENROWSET('SQLNCLI', '...', 'SELECT 1')  -- 외부 데이터 원본
SELECT * FROM OPENQUERY(linked_server, 'SELECT 1')      -- 링크드 서버 경유
SELECT dbo.SideEffectFn(1)                              -- 부수 효과가 있는 사용자 함수
SELECT * FROM sys.sql_logins                            -- 시스템 카탈로그 열람
```

키워드 목록(`INSERT`, `UPDATE`, `DELETE`, `EXEC`, `DROP` 등)에 없는 수단은 걸러지지 않는다.
목록을 늘려도 근본적으로 파서가 아니라 문자열 검사이므로 완전해질 수 없다. PostgreSQL 의
`dblink`/FDW 경유 실행, MySQL·PostgreSQL 의 부수 효과 있는 사용자 함수도 같은 이유로
가드를 통과한다.

정리하면 이렇다.

| 통제 | 우회 |
| --- | --- |
| 임의 SQL tool 부재 | 1~3 전부 |
| `query` 의 읽기 전용 가드 | 4 |
| **DB 계정 권한** | **없음** |

### DB 권한으로 좁히기

**유일하게 우회 불가능한 통제다.** 계정을 만드는 SQL 은 [빠른 시작](#빠른-시작)에 있고,
여기서는 그 위에 더할 수 있는 설정만 다룬다.

다른 DB 와 시스템 카탈로그는 가린다.

```sql
DENY VIEW ANY DATABASE   TO mcp_ro;
DENY VIEW ANY DEFINITION TO mcp_ro;
```

읽기를 더 좁히려면 `db_datareader` 대신 테이블별로 준다.

```sql
GRANT SELECT ON dbo.orders   TO mcp_ro;
GRANT SELECT ON dbo.products TO mcp_ro;
```

`OPENROWSET`(우회 4번)은 서버 수준 설정으로 끈다. `EXECUTE` 를 주지 않으면 같은 4번의
사용자 함수 호출도 함께 막힌다.

```sql
EXEC sp_configure 'Ad Hoc Distributed Queries', 0;
RECONFIGURE;
```

권한을 좁힌 계정을 쓰면 위 우회 경로를 모두 시도해도 SQL Server 가 거부한다.

PostgreSQL / MySQL 도 원리는 같다. `GRANT SELECT ON ALL TABLES`(pg) 나 `GRANT SELECT ON
mydb.*`(mysql) 대신 테이블별 `GRANT SELECT` 로 좁히면 된다. 위 SQL 은 SQL Server 전용이다.

## 알아둘 것

**DB 연결은 첫 tool 호출 때 이루어진다.**
DB 가 꺼져 있어도 서버는 정상 시작하고 `claude mcp get` 이 `✔ Connected` 로 나온다. 연결
실패는 tool 에러로 보고되고 DB 가 복구되면 다음 호출에서 회복된다.

**행 상한은 출력만 줄이고 서버 작업량은 줄이지 않는다.**
`SELECT * FROM huge_table` 은 DB 서버가 여전히 전체 결과를 만든다. 큰 테이블은 `TOP`/`LIMIT`
이나 `WHERE` 로 직접 좁힌다. SQL Server 와 PostgreSQL 은 30초 타임아웃이 걸려 있다.
MySQL 은 클라이언트 쪽 문장 타임아웃이 없어 서버 설정(`max_execution_time`)으로 다룬다.

**DECIMAL / NUMERIC 은 조용히 손실될 수 있다.**
JS `number` 로 변환되므로 2^53 을 넘거나 scale 이 큰 값은 에러 없이 틀린다. 금액 컬럼은
`SELECT CAST(amount AS VARCHAR(50)) AS amount` 처럼 캐스팅한다.

**결과 집합이 여러 개면 첫 번째만 반환한다.** 그 사실을 응답에 명시한다.
