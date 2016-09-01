#!/usr/bin/env bash

mark_as_fail() {
  grep -R "${1}" . --include *-stylo.list -l | xargs -L1 sed -i "/$1/s/^/fails /"
}

# Too many arguments breaks xargs, so we use for loop
for i in $(grep 'UNEXPECTED-FAIL' "${1}" | grep -Po '(?<=\| )(.*)(?===)' | xargs -L1 -I{} basename {})
do
  echo "${i}"
  mark_as_fail "${i}"
done

while grep -R "fails fails " --include *-stylo.list -q
do
  echo "Clean up multiple fails"
  find . -name *-stylo.list | xargs sed -i 's/fails fails /fails /g'
done

find . -name *-stylo.list | xargs sed -i 's/^fails #/#/g'
find . -name *-stylo.list | xargs sed -i 's/^fails load/skip load/g'
# Manually change "fails (.*) load" to skip
