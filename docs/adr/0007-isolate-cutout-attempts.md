# Isolate cutout attempts

A cutout attempt has its own stored identity and output key, separate from the item version a render recipe can pin. A workflow start can report an error after the queue accepted it, so a late worker could otherwise replace a newer result or overwrite a published image. The item version accepts a result only from its pending attempt.

Saving the attempt and starting the workflow remain separate operations. If the request process dies between them, a version can remain pending until an operator investigates.
