/* ECONNRESETの場所を調べるため */
process.on('uncaughtException', function (err) {
    console.error(err.stack);
});
