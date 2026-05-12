# Examples

All examples use this schema:

```typescript
const schema: Schema = {
  entities: {
    User: {
      name: "User",
      primaryKey: "id",
      fields: {
        id:        { type: "number" },
        firstName: { type: "string" },
        lastName:  { type: "string" },
        email:     { type: "string",  nullable: true },
        fiscalCode:{ type: "string",  nullable: true },
        birthDate: { type: "date",    nullable: true },
        age:       { type: "number" },
        active:    { type: "boolean" },
      },
      relations: {
        posts: { target: "Post", kind: "many" },
        team:  { target: "Team", kind: "one" },
      },
    },
    Post: {
      name: "Post",
      primaryKey: "id",
      fields: {
        id:        { type: "number" },
        title:     { type: "string" },
        published: { type: "boolean" },
        createdAt: { type: "date" },
      },
    },
    Team: {
      name: "Team",
      primaryKey: "id",
      fields: {
        id:   { type: "number" },
        name: { type: "string" },
      },
    },
  },
};
```

---

## Basic string search (splitword)

Find users whose first name contains "mario" or "luigi" (case-insensitive):

```json
{
  "searchBy": { "firstName": "mario luigi" }
}
```

`splitword` splits on whitespace and OR-s the words with ILIKE. Matches "Mario", "Luigi", "mario", etc.

---

## Exact string match

Find a user by fiscal code (case-sensitive):

```json
{
  "searchBy": {
    "fiscalCode": {
      "type": "exact",
      "caseSensitive": true,
      "value": "RSSMRA80A01H501Z"
    }
  }
}
```

Defaults to case-insensitive — omit `caseSensitive` (or set to `false`) to match `"rssmra80a01h501z"` too.

---

## Substring match

Find users whose email contains "@example.com":

```json
{
  "searchBy": {
    "email": {
      "mode": "exact",
      "contained": true,
      "value": "@example.com"
    }
  }
}
```

Translates to `LIKE '%@example.com%'`.

---

## Regex search (PostgreSQL only)

Find users whose last name starts with "Ross":

```json
{
  "searchBy": {
    "lastName": {
      "mode": "nativeregex",
      "value": "^Ross"
    }
  }
}
```

Translates to `lastName ~ '^Ross'`.

---

## Numeric comparison

Find users aged 18 or older:

```json
{
  "searchBy": {
    "age": { "operation": ">=", "value": 18 }
  }
}
```

---

## Boolean filter

Active users only:

```json
{
  "searchBy": { "active": true }
}
```

---

## Enum filter

Given an enum field in the schema:

```typescript
const schema: Schema = {
  entities: {
    User: {
      name: "User",
      fields: {
        // ...
        role: { type: "enum", values: ["admin", "moderator", "user"] },
      },
    },
  },
};
```

Filter by enum value:

```json
{ "searchBy": { "role": "admin" } }
```

Invalid values are rejected at parse time:

```json
{ "searchBy": { "role": "superuser" } }
// → QueryValidationError: Field 'role' must be one of: admin, moderator, user (at searchBy.role)
```

For "any of N" matching, use `OR`:

```json
{
  "searchBy": {
    "OR": [
      { "role": "admin" },
      { "role": "moderator" }
    ]
  }
}
```

---

## Presence checks

Users whose `birthDate` is set (column is not NULL):

```json
{ "searchBy": { "birthDate": { "isNull": false } } }
```

Users with no fiscal code recorded (column IS NULL):

```json
{ "searchBy": { "fiscalCode": { "isNull": true } } }
```

Users whose `email` is missing or blank (string-only `isEmpty`):

```json
{ "searchBy": { "email": { "isEmpty": true } } }
```

Active users who have at least one of email / fiscalCode set:

```json
{
  "searchBy": {
    "active": true,
    "OR": [
      { "email":      { "isNull": false } },
      { "fiscalCode": { "isNull": false } }
    ]
  }
}
```

`isNull` works on any primitive field. `isEmpty` is string-only and matches both NULL and `''`.

Both keys may appear together (AND-ed). To match rows that are not NULL but are blank:

```json
{ "searchBy": { "email": { "isNull": false, "isEmpty": true } } }
```

---

## Date — exact

Users born on a specific date:

```json
{
  "searchBy": {
    "birthDate": "1990-06-15T00:00:00Z"
  }
}
```

Or with the object form:

```json
{
  "searchBy": {
    "birthDate": { "year": 1990, "month": 6, "day": 15 }
  }
}
```

---

## Date — range

Users born between 1980 and 1990:

```json
{
  "searchBy": {
    "birthDate": {
      "after":  "1980-01-01T00:00:00Z",
      "before": "1990-12-31T23:59:59Z"
    }
  }
}
```

Either `before` or `after` can be omitted for an open-ended range.

---

## OR conditions

Users named "mario" OR with email containing "rossi":

```json
{
  "searchBy": {
    "OR": [
      { "firstName": "mario" },
      { "email": { "mode": "exact", "contained": true, "value": "rossi" } }
    ]
  }
}
```

---

## AND + OR combined

Active users who are either named "mario" or on the "alpha" team:

```json
{
  "searchBy": {
    "active": true,
    "OR": [
      { "firstName": "mario" },
      { "team": { "name": "alpha" } }
    ]
  }
}
```

---

## Filter by relation

Users who have at least one published post with "typescript" in the title (implicit `some`):

```json
{
  "searchBy": {
    "posts": {
      "published": true,
      "title": "typescript"
    }
  }
}
```

Users whose every post is published:

```json
{
  "searchBy": {
    "posts": { "every": { "published": true } }
  }
}
```

Users with no draft posts at all:

```json
{
  "searchBy": {
    "posts": { "none": { "draft": true } }
  }
}
```

Combine operators on the same relation (AND-ed):

```json
{
  "searchBy": {
    "posts": {
      "some":  { "tags": { "name": "featured" } },
      "every": { "published": true }
    }
  }
}
```

---

## Include relations

Return users with their posts (all post fields):

```json
{
  "include": "all"
}
```

Include only selected post fields:

```json
{
  "include": {
    "posts": { "title": true, "createdAt": true }
  }
}
```

---

## Select specific fields

Return only `firstName` and `email` (plus `id` which is always included):

```json
{
  "select": { "firstName": true, "email": true }
}
```

---

## Sorting

Sort by last name ascending:

```json
{
  "orderBy": { "field": "lastName", "order": "asc" }
}
```

Short form (defaults to `"desc"`):

```json
{ "orderBy": "createdAt" }
```

---

## Pagination

Page 2 of 25 results per page:

```json
{
  "pagination": { "page": 2, "perPage": 25 }
}
```

First result only:

```json
{ "pagination": "first" }
```

---

## Full example

Search for active users named "mario" or "luigi", born after 2000, with at least one post titled "typescript", return first name and email with their posts, sorted by birth date descending, page 0 of 20:

```json
{
  "searchBy": {
    "active": true,
    "birthDate": { "after": "2000-01-01T00:00:00Z" },
    "posts": { "title": "typescript" },
    "OR": [
      { "firstName": "mario" },
      { "firstName": "luigi" }
    ]
  },
  "select": { "firstName": true, "email": true },
  "include": {
    "posts": { "title": true, "published": true }
  },
  "orderBy": { "field": "birthDate", "order": "desc" },
  "pagination": { "page": 0, "perPage": 20 }
}
```

---

## TypeScript: parse only

Use `engine.parse()` when you want to validate and inspect the query before running it:

```typescript
import { QueryValidationError } from "genquery";

function validateQuery(body: unknown) {
  try {
    const parsed = engine.parse(body as GenQueryInput, "User");
    console.log(parsed.pagination); // { kind: "page", page: 0, perPage: 20 }
    return parsed;
  } catch (e) {
    if (e instanceof QueryValidationError) {
      throw new HttpError(400, `Invalid query at ${e.path}: ${e.message}`);
    }
    throw e;
  }
}
```
