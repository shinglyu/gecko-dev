#!/usr/bin/env bash

mark_as_skip() {
  echo "crash ${1}"
  grep -R "${1}" . --include *-stylo.list -l | xargs -L1 sed -i "/$1/s/^/# /"
}

mark_as_fail() {
  grep -R "${1}" . --include *-stylo.list -l | xargs -L1 sed -i "/$1/s/^/fails /"
}

unmark_as_fail() {
  grep -R "${1}" . --include *-stylo.list -l | xargs -L1 sed -i "/$1/s/^fails //"
}

# Too many arguments breaks xargs, so we use for loop
for i in $(grep 'CRASH' "${1}" | awk -F"|" '{print $2}' | xargs -L1 -I{} basename {})
do
  mark_as_skip "${i}"
done

for i in $(grep 'UNEXPECTED-FAIL' "${1}" | grep -Po '(?<=\| )(.*)(?===)' | xargs -L1 -I{} basename {})
do
  echo "fails ${i}"
  mark_as_fail "${i}"
done

for i in $(grep 'UNEXPECTED-PASS' "${1}" | grep -Po '(?<=\| )(.*)(?===)' | xargs -L1 -I{} basename {})
do
  echo "passes ${i}"
  unmark_as_fail "${i}"
done

while grep -R "fails fails " --include *-stylo.list -q
do
  echo "Clean up multiple fails"
  find . -name *-stylo.list | xargs sed -i 's/fails fails /fails /g'
done
while grep -R "skip skip " --include *-stylo.list -q
do
  echo "Clean up multiple skips"
  find . -name *-stylo.list | xargs sed -i 's/skip skip /skip /g'
done

find . -name *-stylo.list | xargs sed -i 's/^fails #/#/g'
find . -name *-stylo.list | xargs sed -i 's/^skip #/#/g'
find . -name *-stylo.list | xargs sed -i 's/^fails load/skip load/g'
find . -name *-stylo.list | xargs sed -i 's/^skip fails /skip /g'
# Manually change "fails (.*) load" to skip
