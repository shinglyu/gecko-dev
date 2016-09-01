#!/usr/bin/env bash

create_stylo_reftestlist(){
  # Cleanup
  find . -name ${1}-stylo.list | xargs rm

  # Copy reftest.list to reftest-stylo.list
  find . -name ${1}.list | xargs -I '{}' cp {} {}.stylo-gecko
  find . -name ${1}.list.stylo-gecko | xargs rename "s/${1}.list.stylo-gecko/${1}-stylo.list/"

  # Add a comment
  find . -name ${1}-stylo.list | xargs -I{} bash -c "echo '# DO NOT EDIT! This is a auto-generated temporary list for Stylo testing' | cat - {} > /tmp/out && mv /tmp/out {}"

  # Make all tests to be expected equal
  find . -name ${1}-stylo.list | xargs sed -i "s/!= /== /g"
  # Wrap inline comment to a new line for easier awk processing
  find . -name ${1}-stylo.list | xargs perl -i -pe 's/^(.*?) (#.*)/$2\n$1/'
  # "== A.html A-ref.html" => "== A.html A.html"
  find . -name ${1}-stylo.list | xargs gawk -i inplace '{if (/==/) {$(NF)=$(NF-1); print} else {print}}'
  ## Change all "include reftest.list" lines to "include reftest-stylo.list"
  find . -name ${1}-stylo.list | xargs sed -i "s/${1}.list/${1}-stylo.list/g"

  # TODO: ref-pref(x) test-pref(y) ... => ref-pref(y) test-pref(y) ...
  # Use this to check if any file becomes empty due to errors
  # find -name ${1}-stylo.list | xargs wc -l |sort -n -r
}

# There are reftest lists that is not named reftest.list
# Use this script to find them:
# find . -name reftest.list | xargs grep "^include" -h | grep -v "reftest.list" | sort | uniq

REFTEST_LISTS="
reftest
default-preferences-tests
reftest_border_abspos
reftest_border_parent
reftest_margin_abspos
reftest_margin_parent
reftest_padding_abspos
reftest_padding_parent
reftest_plain
scripttests
urlprefixtests
"

for i in ${REFTEST_LISTS}; do
  echo "Processing ${i}"
  create_stylo_reftestlist ${i}
done

for i in ${REFTEST_LISTS}; do
  for j in ${REFTEST_LISTS}; do
    echo "Replacing  string ${j} in all ${i}.list"
    find . -name ${i}-stylo.list | xargs sed -i "s/${j}.list/${j}-stylo.list/g"
  done
done

disable_crash() {
  find . -name *-stylo.list | xargs grep "${1}" -l  | xargs sed -i "/$1/s/^/skip /"
}

CRASHES="
bug863728-2.html
212563-2.html
376484-1.html
381746-1.html
445004-1.html
482659-1d.html
display-contents-style-inheritance-1-dom-mutations.html
block-xhtml-root-1b.xhtml
block-xhtml-root-2.xhtml
block-xhtml-root-3.xhtml
pseudo-element-of-native-anonymous.html
modify-range.html
dom-mutations.html
deferred-anim-1.xhtml
deferred-tree-1.xhtml
event-target-non-svg-1.xhtml
cross-container-1.xhtml
cross-container-3.xhtml
calc-in-media-queries-001.html
calc-in-media-queries-002.html
ruby-inlinize-blocks-002.html
1267937-1.html
stacking-context-opacity-changing-keyframe.html
stacking-context-opacity-changing-target.html
stacking-context-transform-changing-keyframe.html
stacking-context-transform-changing-target.html
block-xhtml-root-1a.xhtml
stress-3.html
474472-1.html
1161752.html
text-shadow-on-selection-1.html
aja-linear-3a.html
212563-1.html
bug608373-1.html
413292-1.html
stacking-context-transform-changing-display-property.html
splitText-normalize.html
list-1.html
text-shadow-on-selection-2.html
input-transition-1.html
meter-vlr-orient-vertical.html
bug599320-1.html
background-clip-text-1a.html
480880-1c.html
482659-1c.html
1246046-1.html
388980-1.html
bug945215-2.html
aja-linear-1d.html
"

for i in $CRASHES;
do
  echo "Processing $i"
  disable_crash $i
done

for i in ${REFTEST_LISTS}; do
  echo "git add ${i}-stylo.list"
  find . -name ${i}-stylo.list | xargs git add
done
