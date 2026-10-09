# scp -r index.html style.css js/ audio/ gmu:www/shapesonic/demo/
# cp -R index.html style.css js audio ~/Work/exposition/academic_page/shapesonic/demo/
rsync -rc --itemize-changes index.html style.css js audio ~/Work/exposition/academic_page/shapesonic/demo/
## Verify with:
# diff -r -q . ~/Work/exposition/academic_page/shapesonic/demo/

# cd ~/Work/exposition/academic_page
# . UPLOAD
