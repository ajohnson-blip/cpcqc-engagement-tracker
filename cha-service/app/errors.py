"""Errors a program raises when a REDCap project is not set up as its rules expect."""


class ProjectConfigurationError(Exception):
    """The project is readable but cannot be relied on — for example a data
    dictionary label that breaks the pattern the rules depend on. The run for
    that program fails as a configuration error rather than guess.

    Messages may quote the data dictionary (field names, codes, labels), which
    describes the project, never record content.
    """
