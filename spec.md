# Spec

This is somewhat of a "spec" that defines the query language.

It's not a proper spec, more like an example than a spec, but it's fairly comprehensive.

## OR
	`|` means or in the definition, `"asc" | "desc"` means either "asc" or "desc".
	So `string | {}` means either a string or an empty object.

## Default
	`@` means that that is a default value.
	This means that in `"asc" | @"desc"`, `"desc"` is default if the option is not specified.

## Non optional
	`*` means that that is not an optional value, it's mandatory inside of the object it is defined into.

## Array types
	When a type is specified like this: `[type]` it means that it's an array composed of many `type`.

## type definitions:
	```json
		offsetType: string | @"Z",

		dateTimeType: string (ISO 8601) | {
			year: int,
			month: int,
			day: int,
			hours: int,
			minutes: int,
			seconds: int,
			offset: offsetType
		},

		numericComparisonType: {
			operation: ">" | "<" | ">=" | "<=" | @"=="
			*value: number
		},
	```

	In the dateTimeType object when it's not an iso string all fields are optional. If not specified offset will have "Z" as default

## String search modes

Strings may be searched using different search modes.

### Splitword (current default)

Any search string will be split by whitespace and searched against every piece of the now split query.

For example given this query to find a user in our table:

```json
{
	searchBy: {
		firstname: "mario rossi",
		lastname: "mario rossi",
	}
}
```

with splitword the result of the query would include anything that respect ALL the following conditions:

- firstname: is either "mario" or "rossi"
- lastname is either "mario" or "rossi"

so the following user would all be found by the query:
```json
[
	{
		firstname: "mario",
		lastname: "mario"
	},
	{
		firstname: "mario",
		lastname: "rossi"
	},
	{
		firstname: "rossi",
		lastname: "rossi"
	},
	{
		firstname: "rossi",
		lastname: "mario"
	}
]
```

Of course here `firstname` and `lastname` are the same but this might not always be the case.

### exact

Just as it sounds, the string that is specified is the string that gets found, nothing more, nothing less.

### nativeregex

A string is searched against a specified regex. The regex is in the language natively supported by the ORM or the database, so no kind of processing is done on it.

# example:
```json
{
	orderBy: string | { // if orderBy is a string then default order is "desc" just as described below

		*field: string, // field: nameOfTheFieldToPerformSortingOperationsOn
		order: "asc" | @"desc",

	},

	searchBy: {

		// string


		exampleStringField: string | { // when only a string is specified, default values apply here
			mode: @"splitword" | "exact" | "nativeregex"

			contained: true | @false, // This means that the query should match as part of a string, so "something" would also match "somethingelse"

			caseSensitive: true | @false, // When false (default), comparison is case-insensitive. Applies to all modes including nativeregex.

			*value: "something", // a value
		},

		firstname: "mario rossi",
		lastname: "mario rossi", // remember splitword

		fiscalCode: {
			type: "exact"
			value: "AFISCALCODE123"
		},

		// date

		date: dateTimeType | { before: dateTimeType, after: dateTimeType }, // either before or after can be omitted from the object

		// relations

		relationName: {
			otherField: "lorem ipsum"
		},

		// bool

		exampleBoolField: true,

		// number

		exampleNumberField: number | {
			operation: ">" | "<" | ">=" | "<=" | @"==",
			*value: number
		},

		// enum

		// An enum field must be a string value that matches one of the allowed
		// values declared in the schema. The parser rejects anything else.
		exampleEnumField: "allowedValue1" | "allowedValue2" | ...,

		// OR

		OR: [
			searchBy, // recursive
			searchBy, // here all the searchBy(s) are evaluated similar to prisma's OR
			searchBy,
		]
	},

	include: @"none" | "all" | { // which relations to include in the query result
		relationField: {
			firstname: true // only firstname will be included from relationField
		},
		otherRelation: "all", // all fields will be included from otherRelation
	},

	select: "none" | @"all" |  { // which fields to include in the query result
		someField: true, // only field 'someField' will be included in the query this way
	},

	pagination: @"all" | "first" | { // using first makes this a "findFirst" type query, equivalent to page: 0 and perPage: 1.
		page: int | @0,
		perPage: int | @20,
	}
}
```