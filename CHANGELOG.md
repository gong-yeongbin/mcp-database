# Changelog

## [1.0.0](https://github.com/gong-yeongbin/mcp-database/compare/v0.4.0...v1.0.0) (2026-10-19)

### ⚠ BREAKING CHANGES

* 0.4.0 에서 list_procedures / describe_procedure / call_procedure tool 이
  제거되었다. 조회 tool 3개(list_tables, describe_table, query)만 남는다.

### Features

* 1.0.0 릴리스 ([0c67824](https://github.com/gong-yeongbin/mcp-database/commit/0c67824e5bd368441caed6a9cf70778be7cd0f5a))

## [0.4.0](https://github.com/gong-yeongbin/mcp-database/compare/v0.3.2...v0.4.0) (2026-10-19)

### Features

* 프로시저 tool 을 제거하고 query 수신 경로를 최적화 ([6e39289](https://github.com/gong-yeongbin/mcp-database/commit/6e392897522be5243bd1ced1e25d0cf3a2c76963))

### Bug Fixes

* index.ts 에 남은 충돌 마커를 제거 ([71c0de5](https://github.com/gong-yeongbin/mcp-database/commit/71c0de594bd8931178621663a4f762e1c11cb1c3))

## [0.3.2](https://github.com/gong-yeongbin/mcp-database/compare/v0.3.1...v0.3.2) (2026-08-29)

### Bug Fixes

* 저장소 이름 변경에 맞춰 package.json 의 URL 을 고침 ([987e168](https://github.com/gong-yeongbin/mcp-database/commit/987e168940c06b2daf9167a1fcc4d442d705ec03))

## [0.3.1](https://github.com/gong-yeongbin/mcp-database/compare/v0.3.0...v0.3.1) (2026-08-29)

### Bug Fixes

* Node 22 에서 서버가 즉시 종료되던 실행 가드를 고침 ([7893ad0](https://github.com/gong-yeongbin/mcp-database/commit/7893ad0600b2f4fb65f5ae25ffcf89275d56016a))

## [0.3.0](https://github.com/gong-yeongbin/database-mcp/compare/v0.2.0...v0.3.0) (2026-08-06)

### Features

* PostgreSQL / MySQL 지원을 추가 ([c3f68ce](https://github.com/gong-yeongbin/database-mcp/commit/c3f68ced27ec62b3fefc8c6bac1b9f96d00a7466))

## [0.2.0](https://github.com/gong-yeongbin/database-mcp/compare/v0.1.1...v0.2.0) (2026-08-05)

### Features

* ALLOW_PROCEDURE 환경변수를 제거하고 프로시저 tool 을 항상 등록 ([15b86c1](https://github.com/gong-yeongbin/database-mcp/commit/15b86c118ca81c4cacb11fd6fa9403e0edbf7a5e))

## [0.1.1](https://github.com/gong-yeongbin/database-mcp/compare/v0.1.0...v0.1.1) (2026-07-31)

### Bug Fixes

* 실효 없는 소스맵을 배포 tarball 에서 제외 ([6cdd82c](https://github.com/gong-yeongbin/database-mcp/commit/6cdd82cb911b4f80581912c3f74a659137d85c70))
