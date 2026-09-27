# TODO

Every tracked bug (B19-B59, S1-S3) is fixed; their diagnoses and fixes are in
`Test/known-bugs.js`. A new bug gets an id there and tests marked with it in
`Test/LanguageTests.js` / `Test/StdlibTests.js`; they are expected to fail until it is
fixed, and `node Test/LanguageTests.js --bugs` runs just those tests.

`--memcheck --leaks` on every test finds no invalid frees, use-after-frees or leaks.

## Known limitations

- `--check` and the language server report only the first error in a file.
