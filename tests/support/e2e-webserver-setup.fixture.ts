if (process.env.TEST_E2E_SETUP_FAILURE === 'true') process.exit(13);
console.log('Fixture setup waiting');
setInterval(() => {}, 1000);
